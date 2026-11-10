(function(global) {
    'use strict';

    var BOOKS_KEY = 'my_books_data';
    var SETTINGS_KEY = 'my_bill_summary_settings';
    var running = false;
    var started = false;
    var timer = null;

    function pad(value) { return String(value).padStart(2, '0'); }
    function dateKey(date) { return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()); }
    function monthKey(date) { return date.getFullYear() + '-' + pad(date.getMonth() + 1); }
    function isSummaryMinute(date) { return date.getHours() === 23 && date.getMinutes() >= 59; }
    function monthEndDate(month) {
        var parts = month.split('-');
        var last = new Date(Number(parts[0]), Number(parts[1]), 0).getDate();
        return month + '-' + pad(last);
    }
    function isLastDayOfMonth(date) { return date.getDate() === new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate(); }

    function normalizeSettings(raw, now) {
        raw = raw && typeof raw === 'object' ? raw : {};
        var today = dateKey(now);
        var thisMonth = monthKey(now);
        var daily = raw.daily === true;
        var monthly = raw.monthly === true;
        return {
            daily: daily,
            monthly: monthly,
            dailySince: daily && /^\d{4}-\d{2}-\d{2}$/.test(String(raw.dailySince || '')) ? raw.dailySince : (daily ? today : null),
            monthlySince: monthly && /^\d{4}-\d{2}$/.test(String(raw.monthlySince || '')) ? raw.monthlySince : (monthly ? thisMonth : null)
        };
    }

    function getSettings() {
        var raw = {};
        try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (_) {}
        return normalizeSettings(raw, new Date());
    }

    function saveSettings(settings) {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
            return true;
        } catch (_) {
            return false;
        }
    }

    function setEnabled(kind, enabled) {
        var now = new Date();
        var settings = getSettings();
        if (kind !== 'daily' && kind !== 'monthly') return settings;
        settings[kind] = enabled === true;
        if (settings[kind]) {
            if (kind === 'daily') settings.dailySince = dateKey(now);
            if (kind === 'monthly') settings.monthlySince = monthKey(now);
        }
        saveSettings(settings);
        if (settings[kind]) runNow(now);
        return getSettings();
    }

    function replaceSettings(raw) {
        var settings = normalizeSettings(raw, new Date());
        saveSettings(settings);
        return getSettings();
    }

    function getBooks() {
        try {
            var books = JSON.parse(localStorage.getItem(BOOKS_KEY) || '{}');
            return books && typeof books === 'object' && !Array.isArray(books) ? books : {};
        } catch (_) {
            return {};
        }
    }

    function amountInCents(record) {
        var amount = Number(record && record.amount);
        return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
    }

    function sourceCount(record) {
        var count = Number(record && record.summaryCount);
        return Number.isFinite(count) && count > 0 ? Math.round(count) : 1;
    }

    function hashText(text) {
        var hash = 2166136261;
        for (var i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function makeSummary(level, period, type, category, cents, count) {
        var isDaily = level === 'daily';
        var recordDate = isDaily ? period : monthEndDate(period);
        return {
            id: 'summary_' + level + '_' + period + '_' + type + '_' + hashText(category),
            note: '',
            amount: Number((cents / 100).toFixed(2)),
            type: type,
            category: category,
            date: recordDate,
            time: recordDate + ' 23:59:00',
            summaryPeriod: level,
            summaryKey: period,
            summaryCount: count
        };
    }

    function validRecord(record) {
        return record && (record.type === 'income' || record.type === 'expense') &&
            typeof record.category === 'string' && record.category.trim() &&
            /^\d{4}-\d{2}-\d{2}$/.test(String(record.date || '')) && amountInCents(record) > 0;
    }

    function eligibleDay(day, settings, now) {
        if (!settings.daily || day < settings.dailySince) return false;
        var today = dateKey(now);
        return day < today || (day === today && isSummaryMinute(now));
    }

    function eligibleMonth(month, settings, now) {
        if (!settings.monthly || month < settings.monthlySince) return false;
        var current = monthKey(now);
        return month < current || (month === current && isLastDayOfMonth(now) && isSummaryMinute(now));
    }

    function replaceGroups(records, groups, level) {
        var removed = {};
        var replacements = {};
        var changedGroups = 0;

        Object.keys(groups).forEach(function(key) {
            var items = groups[key];
            var first = items[0];
            var record = first.record;
            var period = level === 'daily' ? record.date : record.date.slice(0, 7);
            var alreadySummarized = items.length === 1 && record.summaryPeriod === level &&
                record.summaryKey === period && (level === 'daily' || record.date === monthEndDate(period));
            if ((level === 'daily' && items.length < 2) || alreadySummarized) return;

            var cents = 0;
            var count = 0;
            items.forEach(function(item) {
                cents += amountInCents(item.record);
                count += sourceCount(item.record);
                removed[item.index] = true;
            });
            replacements[first.index] = makeSummary(level, period, record.type, record.category.trim(), cents, count);
            changedGroups++;
        });

        if (!changedGroups) return { records: records, groups: 0 };
        var result = [];
        records.forEach(function(record, index) {
            if (replacements[index]) result.push(replacements[index]);
            if (!removed[index]) result.push(record);
        });
        return { records: result, groups: changedGroups };
    }

    function summarizeDaily(records, settings, now) {
        var groups = {};
        records.forEach(function(record, index) {
            if (!validRecord(record) || record.summaryPeriod === 'monthly' || !eligibleDay(record.date, settings, now)) return;
            var key = record.date + '\u0001' + record.type + '\u0001' + record.category.trim();
            if (!groups[key]) groups[key] = [];
            groups[key].push({ record: record, index: index });
        });
        return replaceGroups(records, groups, 'daily');
    }

    function summarizeMonthly(records, settings, now) {
        var groups = {};
        records.forEach(function(record, index) {
            if (!validRecord(record)) return;
            var month = record.date.slice(0, 7);
            if (!eligibleMonth(month, settings, now)) return;
            var key = month + '\u0001' + record.type + '\u0001' + record.category.trim();
            if (!groups[key]) groups[key] = [];
            groups[key].push({ record: record, index: index });
        });
        return replaceGroups(records, groups, 'monthly');
    }

    function emitUpdate(detail) {
        try { global.dispatchEvent(new CustomEvent('bill-summary-updated', { detail: detail })); } catch (_) {}
    }

    function clearGeneratedNotes() {
        try {
            var books = getBooks();
            var changed = false;
            Object.keys(books).forEach(function(name) {
                var book = books[name];
                if (!book || !Array.isArray(book.records)) return;
                book.records = book.records.map(function(record) {
                    var generated = record && (record.summaryPeriod === 'daily' || record.summaryPeriod === 'monthly') &&
                        typeof record.note === 'string' && /^(?:日汇总|月汇总)(?:\s*·\s*\d+笔)?$/.test(record.note.trim());
                    if (!generated) return record;
                    changed = true;
                    return Object.assign({}, record, { note: '' });
                });
            });
            if (changed) {
                localStorage.setItem(BOOKS_KEY, JSON.stringify(books));
                emitUpdate({ changed: true, dailyGroups: 0, monthlyGroups: 0, reduced: 0 });
            }
            return changed;
        } catch (_) {
            return false;
        }
    }

    function runNow(nowOverride) {
        if (running) return { changed: false, busy: true };
        running = true;
        try {
            var now = nowOverride instanceof Date ? nowOverride : new Date();
            var settings = getSettings();
            if (!settings.daily && !settings.monthly) return { changed: false, dailyGroups: 0, monthlyGroups: 0, reduced: 0 };
            var books = getBooks();
            var changed = false;
            var dailyGroups = 0;
            var monthlyGroups = 0;
            var beforeCount = 0;
            var afterCount = 0;

            Object.keys(books).forEach(function(name) {
                var book = books[name];
                if (!book || !Array.isArray(book.records)) return;
                var records = book.records;
                beforeCount += records.length;
                if (settings.daily) {
                    var dailyResult = summarizeDaily(records, settings, now);
                    records = dailyResult.records;
                    dailyGroups += dailyResult.groups;
                }
                if (settings.monthly) {
                    var monthlyResult = summarizeMonthly(records, settings, now);
                    records = monthlyResult.records;
                    monthlyGroups += monthlyResult.groups;
                }
                afterCount += records.length;
                if (records !== book.records) {
                    book.records = records;
                    changed = true;
                }
            });

            if (changed) {
                localStorage.setItem(BOOKS_KEY, JSON.stringify(books));
                try { localStorage.setItem('stats_needs_refresh', String(Date.now())); } catch (_) {}
                emitUpdate({ changed: true, dailyGroups: dailyGroups, monthlyGroups: monthlyGroups, reduced: beforeCount - afterCount });
            }
            return { changed: changed, dailyGroups: dailyGroups, monthlyGroups: monthlyGroups, reduced: beforeCount - afterCount };
        } catch (_) {
            return { changed: false, error: true };
        } finally {
            running = false;
        }
    }

    function start() {
        if (started) return;
        started = true;
        var begin = function() {
            clearGeneratedNotes();
            runNow();
            if (!timer) timer = global.setInterval(runNow, 30000);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
        else begin();
        document.addEventListener('visibilitychange', function() { if (!document.hidden) runNow(); });
        global.addEventListener('focus', function() { runNow(); });
    }

    global.BillSummary = {
        getSettings: getSettings,
        setEnabled: setEnabled,
        replaceSettings: replaceSettings,
        clearGeneratedNotes: clearGeneratedNotes,
        runNow: runNow,
        start: start
    };
    start();
})(window);
