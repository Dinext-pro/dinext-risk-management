// Ensure "Рассчитать прогноз" menu array exists for Dinext Projects (used in refresh to add our item conditionally)
frappe.provide("dinext_projects.project_pl_forecast_menu");
if (!Array.isArray(dinext_projects.project_pl_forecast_menu)) {
    dinext_projects.project_pl_forecast_menu = [];
}

/** Return true if dimensions arrays match (same doc:docname set). */
function reserveDimensionsEqual(dim1, dim2) {
    return dimSignature(dim1) === dimSignature(dim2);
}

/** Check if account has Task dimension from aggregatedBudget (Accounting Dimension Filter data). */
function accountHasTaskDimension(aggregatedBudget, account) {
    if (!aggregatedBudget || !account) return false;
    var row = aggregatedBudget[account];
    if (!row || !row.allowed_dimensions) return false;
    return row.allowed_dimensions.some(function(ad) {
        return ad && ad.document_type === 'Task';
    });
}

/**
 * Get periods for reserve by type. Uses get_budget_display_periods when available (project_pl.js).
 * Reserve is applied only to periods where is_past === false (future periods).
 * reserve_period: "Месяц" | "Квартал" | "Год" | "Проект" | "Задача" | "Проект / Задача"
 * Returns [{ year, month }].
 */
function getReservePeriods(frm, reserve_period) {
    var periodType = (reserve_period || 'Месяц').trim();
    var allPeriods = [];
    if (typeof get_budget_display_periods === 'function') {
        allPeriods = get_budget_display_periods(frm, 'month') || [];
    }
    if (!allPeriods.length) return [];
    // Reserve only in future periods (is_past === false)
    var futurePeriods = allPeriods.filter(function(p) { return p.is_past === false; });
    if (periodType === 'Месяц') {
        return futurePeriods.map(function(p) { return { year: p.year, month: p.month }; });
    }
    if (periodType === 'Квартал') {
        return futurePeriods.filter(function(p) {
            return p.month === 3 || p.month === 6 || p.month === 9 || p.month === 12;
        }).map(function(p) { return { year: p.year, month: p.month }; });
    }
    if (periodType === 'Год') {
        var seenY = {};
        return futurePeriods.filter(function(p) {
            if (p.month !== 12) return false;
            if (seenY[p.year]) return false;
            seenY[p.year] = true;
            return true;
        }).map(function(p) { return { year: p.year, month: p.month }; });
    }
    if (periodType === 'Проект / Задача' || periodType === 'Проект' || periodType === 'Задача') {
        var last = futurePeriods[futurePeriods.length - 1];
        return last ? [{ year: last.year, month: last.month }] : [];
    }
    return futurePeriods.map(function(p) { return { year: p.year, month: p.month }; });
}

/**
 * Get basis (forecast) amounts by period from aggregatedBudget for given account and dimensions.
 * dimensions: without Project Risk (only Task if any). Returns object keyed by "year_month".
 */
function getBasisAmountsFromAggregated(aggregatedBudget, account, dimensions, periods) {
    var out = {};
    if (!aggregatedBudget || !account || !periods.length) return out;
    var row = aggregatedBudget[account];
    if (!row || !row.dimension_data) return out;
    var bucket = row.dimension_data.find(function(b) {
        return reserveDimensionsEqual(b.dimensions || [], dimensions);
    });
    if (!bucket) return out;
    for (var i = 0; i < periods.length; i++) {
        var p = periods[i];
        var key = 'forecast_' + p.year + '_' + p.month;
        out[p.year + '_' + p.month] = flt(bucket[key], 2);
    }
    return out;
}

/**
 * Compute reserve amount per period for one risk row. Returns object {"Y_M": amount}.
 */
function getReserveAmountsByPeriod(row, periods, aggregatedBudget, frm) {
    var periodAmountMap = {};
    var method = (row.reserve_method || '').trim();
    if (method === 'Сумма') {
        var amount = flt(row.reserve_amount, 2);
        for (var i = 0; i < periods.length; i++) {
            var p = periods[i];
            periodAmountMap[p.year + '_' + p.month] = amount;
        }
        return periodAmountMap;
    }
    if (method === 'Процент') {
        var basisAccount = (row.reserve_basis_account || '').trim();
        var percent = flt(row.reserve_percent, 2);
        if (!basisAccount) return periodAmountMap;
        var dimensionsForBasis = [];
        if (row.task && accountHasTaskDimension(aggregatedBudget, (row.reserve_account || '').trim())) {
            dimensionsForBasis.push({ doc: 'Task', docname: row.task });
        }
        var basis = getBasisAmountsFromAggregated(aggregatedBudget, basisAccount, dimensionsForBasis, periods);
        for (var i = 0; i < periods.length; i++) {
            var p = periods[i];
            var k = p.year + '_' + p.month;
            periodAmountMap[k] = flt((basis[k] || 0) * percent / 100, 2);
        }
        return periodAmountMap;
    }
    return periodAmountMap;
}

/**
 * Simulated budget = deep copy via jQuery.extend; then add reserve amounts into matching buckets.
 * Reuses get_child_budget_sum and clearBudgetIndexCacheFor from project_pl_calc.js.
 */
function applyReserveToSimulated(simulated, updates) {
    if (!simulated || !updates || !updates.length) return;
    for (var u = 0; u < updates.length; u++) {
        var item = updates[u];
        var account = (item.account || '').trim();
        var dimensions = item.dimensions || [];
        const taskId = dimensions.find(d => d && d.doc === "Task")?.docname;
        const riskDim = dimensions.find(d => d && d.doc === "Project Risk")?.docname;
        var periodAmountMap = item.period_amount_map || {};
        var rowKey = getBudgetKey( account, taskId, riskDim );
        var row = simulated[rowKey];
        if (!row && riskDim) {
            var parentKey = getBudgetKey( account, taskId );
            var parent_row = simulated[parentKey];
            if ( parent_row ) {
                row = {
                    ...parent_row,
                    value: parent_row.value,
                    indent: (parent_row.indent || 0) + 1,
                    _parentKey: parentKey,
                    risk: { value: riskDim },
                    dimension_data: [{dimensions: dimensions}]
                };
                simulated[ getBudgetRowKey( row ) ] = row;
            }
        }
        if (!row) continue;
        var bucket = row.dimension_data.find(function(b) { return reserveDimensionsEqual(b.dimensions || [], dimensions); });
        if (!bucket) continue;
        for (var periodKey in periodAmountMap) {
            if (!Object.prototype.hasOwnProperty.call(periodAmountMap, periodKey)) continue;
            var amount = flt(periodAmountMap[periodKey], 2);
            if (amount <= 0) continue;
            var parts = (periodKey + '').split('_');
            if (parts.length >= 2) {
                var fk = 'forecast_' + parts[0] + '_' + parts[1];
                bucket[fk] = flt((bucket[fk] || 0) + amount, 2);
            }
        }
    }
}

/**
 * Build parent_adjustments using get_parent_budget_limit and get_child_budget_sum from dinext_projects_pl.
 * For each update and period, walks up via get_parent_budget_limit; when parent needs increase (non-zero and < sum of children),
 * uses get_child_budget_sum for required value; stops when a non-zero parent needs no correction.
 */
function buildParentAdjustments(frm, updates) {
    var parent_adjustments = [];
    var adjusted_parents = [];
    if (!frm.aggregatedBudget || !updates || !updates.length) return { parent_adjustments: parent_adjustments, adjusted_parents: adjusted_parents };
    if (typeof get_parent_budget_limit !== 'function' || typeof get_child_budget_sum !== 'function') return { parent_adjustments: parent_adjustments, adjusted_parents: adjusted_parents };

    var simulated = (typeof $ !== 'undefined' && $.extend) ? $.extend(true, {}, frm.aggregatedBudget) : JSON.parse(JSON.stringify(frm.aggregatedBudget));
    applyReserveToSimulated(simulated, updates);
    if (typeof clearBudgetIndexCacheFor === 'function') clearBudgetIndexCacheFor(simulated);

    var allPeriods = [];
    var periodKeys = {};
    for (var u = 0; u < updates.length; u++) {
        var pm = updates[u].period_amount_map || {};
        for (var pk in pm) {
            if (periodKeys[pk]) continue;
            periodKeys[pk] = true;
            var parts = (pk + '').split('_');
            if (parts.length >= 2) allPeriods.push({ year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) });
        }
    }
    if (!allPeriods.length) return { parent_adjustments: parent_adjustments, adjusted_parents: adjusted_parents };

    var adjustmentMap = {};
    for (var ui = 0; ui < updates.length; ui++) {
        var item = updates[ui];
        var account = (item.account || '').trim();
        var dimensions = item.dimensions || [];
        var taskId = '';
        var riskDocname = '';
        for (var di = 0; di < dimensions.length; di++) {
            if (dimensions[di] && dimensions[di].doc === 'Task') taskId = dimensions[di].docname || '';
            if (dimensions[di] && dimensions[di].doc === 'Project Risk') riskDocname = dimensions[di].docname || '';
        }
        for (var pi = 0; pi < allPeriods.length; pi++) {
            var period = allPeriods[pi];
            var accountCur = account;
            var taskIdCur = taskId;
            var dimsCur = dimensions;
            var riskCur = riskDocname || null;
            var reverveValue = flt(item.period_amount_map[period.year + '_' + period.month]);
            while (true) {
                var limitResult = typeof get_parent_budget_limit === 'function'
                    ? get_parent_budget_limit(accountCur, taskIdCur, dimsCur, period, simulated, riskCur)
                    : null;
                if (!limitResult) break;               
                var simRow = simulated[ getBudgetRowKey( limitResult.parent ) ];
                var parentForecast = 0;
                var bucket = null;
                if (simRow && simRow.dimension_data) {
                    bucket = simRow.dimension_data.find(function(b) { return reserveDimensionsEqual(b.dimensions || [], limitResult.dim); });
                    if (bucket) parentForecast = flt(bucket['forecast_' + period.year + '_' + period.month], 2);
                }
                let requiredValue = parentForecast + reverveValue - limitResult.maxAllowed;
                if (parentForecast > 0 && parentForecast < requiredValue && bucket) {
                    bucket['forecast_' + period.year + '_' + period.month] = flt(requiredValue, 2);
                    if (typeof clearBudgetIndexCacheFor === 'function') clearBudgetIndexCacheFor(simulated);
                    var adjKey = (limitResult.parent.value || '') + '|' + reserveDimensionsKey(limitResult.dim);
                    if (!adjustmentMap[adjKey]) {
                        adjustmentMap[adjKey] = { account: limitResult.parent.value, dimensions: limitResult.dim, period_amount_map: {} };
                        adjusted_parents.push({ account: limitResult.parent.value, dimensions: limitResult.dim });
                    }
                    adjustmentMap[adjKey].period_amount_map[period.year + '_' + period.month] = requiredValue;
                }
                if (parentForecast > 0 && parentForecast >= requiredValue) break;
                accountCur = limitResult.parent.value;
                taskIdCur = limitResult.parent.task ? limitResult.parent.task.value : '';
                dimsCur = limitResult.dim;
                riskCur = null;
            }
        }
    }
    for (var adjKey in adjustmentMap) {
        if (Object.prototype.hasOwnProperty.call(adjustmentMap, adjKey)) parent_adjustments.push(adjustmentMap[adjKey]);
    }
    return { parent_adjustments: parent_adjustments, adjusted_parents: adjusted_parents };
}

/**
 * Build updates array for bulk_save_reserve_budgets from selected risk names.
 * Requires frm.aggregatedBudget. Returns { updates: [...], skipped: number }.
 */
function buildReserveUpdates(frm, selected_source_names) {
    var aggregatedBudget = frm.aggregatedBudget;
    var risks = frm.doc.custom_project_risks || [];
    var updates = [];
    var skipped = 0;
    for (var n = 0; n < selected_source_names.length; n++) {
        var name = selected_source_names[n];
        var row = risks.filter(function(r) { return r.name === name; })[0];
        if (!row) { skipped++; continue; }
        if (!row.contingency_reserve || row.status === 'Closed') { skipped++; continue; }
        var reserveAccount = (row.reserve_account || '').trim();
        if (!reserveAccount) { skipped++; continue; }
        var reservePeriod = (row.reserve_period || 'Месяц').trim();
        var periods = getReservePeriods(frm, reservePeriod);
        if (!periods.length) { skipped++; continue; }
        var dimensions = [];
        if (row.task && accountHasTaskDimension(aggregatedBudget, reserveAccount)) {
            dimensions.push({ doc: 'Task', docname: row.task });
        }
        dimensions.push({ doc: 'Project Risk', docname: row.name || name });
        var periodAmountMap = getReserveAmountsByPeriod(row, periods, aggregatedBudget, frm);
        var hasPositive = Object.keys(periodAmountMap).some(function(k) { return periodAmountMap[k] > 0; });
        if (!hasPositive) { skipped++; continue; }
        updates.push({
            account: reserveAccount,
            dimensions: dimensions,
            period_amount_map: periodAmountMap
        });
    }
    return { updates: updates, skipped: skipped };
}

/** Return risks eligible for reserve: contingency_reserve set and status !== 'Closed'. */
function getReserveRisksEligible(frm) {
    var rows = frm.doc.custom_project_risks || [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.contingency_reserve && r.status !== 'Closed') {
            out.push({ index: i, row: r });
        }
    }
    return out;
}

function formatReserveMagnitude(row) {
    if (row.reserve_method === 'Сумма') {
        return row.reserve_amount != null ? format_currency(row.reserve_amount, row.currency || frappe.defaults.get_default('currency'), 2) : '';
    }
    if (row.reserve_method === 'Процент') {
        return row.reserve_percent != null ? flt(row.reserve_percent, 2) + '%' : '';
    }
    return '';
}

/** Native title on grid static cells so ellipsis-truncated text shows full value on hover. */
function applyReserveRisksGridCellTitles(grid) {
    if (!grid || !grid.grid_rows || !grid.grid_rows.length) return;
    var fields = ['subject', 'reserve_account', 'reserve_period', 'magnitude'];
    for (var i = 0; i < grid.grid_rows.length; i++) {
        var grid_row = grid.grid_rows[i];
        if (!grid_row || !grid_row.doc) continue;
        for (var f = 0; f < fields.length; f++) {
            var fieldname = fields[f];
            var col = grid_row.columns[fieldname];
            if (!col || !col.static_area || !col.static_area.length) continue;
            var val = grid_row.doc[fieldname];
            col.static_area.attr('title', val == null ? '' : String(val));
        }
    }
}

function openReserveRisksDialog(frm) {
    var eligible = getReserveRisksEligible(frm);
    if (!eligible.length) {
        frappe.msgprint(__('Нет актуальных рисков с начислением резерва.'));
        return;
    }

    var data = eligible.map(function(item, i) {
        return {
            name: item.row.name,
            idx: i + 1,
            subject: item.row.subject || '',
            reserve_account: item.row.reserve_account || '',
            reserve_period: item.row.reserve_period || '',
            reserve_method: item.row.reserve_method || '',
            magnitude: formatReserveMagnitude(item.row),
            _source_index: item.index
        };
    });

    var dialog = new frappe.ui.Dialog({
        title: __('Включить резерв на риски'),
        size: 'large',
        fields: [
            {
                fieldname: 'reserve_risks_table',
                fieldtype: 'Table',
                options: '',
                cannot_add_rows: 1,
                cannot_delete_rows: 1,
                in_place_edit: true,
                fields: [
                    { fieldname: 'idx', fieldtype: 'Int', label: __('№'), in_list_view: 1, read_only: 1, columns: 1 },
                    { fieldname: 'subject', fieldtype: 'Data', label: __('Риск'), in_list_view: 1, read_only: 1, columns: 3 },
                    { fieldname: 'reserve_account', fieldtype: 'Data', label: __('Статья начисления'), in_list_view: 1, read_only: 1, columns: 2 },
                    { fieldname: 'reserve_period', fieldtype: 'Data', label: __('Период'), in_list_view: 1, read_only: 1, columns: 2 },
                    //{ fieldname: 'reserve_method', fieldtype: 'Data', label: __('Метод'), in_list_view: 1, read_only: 1, columns: 1 },
                    { fieldname: 'magnitude', fieldtype: 'Data', label: __('Величина'), in_list_view: 1, read_only: 1, columns: 2 },
                    { fieldname: '_source_index', fieldtype: 'Int', hidden: 1 }
                ],
                data: data
            },
            {                
                fieldname: 'reserve_risks_description',
                fieldtype: 'HTML',
                options: __("При добавлении / обновлении резервов на риски возможно обновление родительских статей для соблюдения логики иерархичности значений"),
            }
        ],
        primary_action_label: __('Рассчитать'),
        primary_action: function() {
            var grid = dialog.fields_dict.reserve_risks_table && dialog.fields_dict.reserve_risks_table.grid;
            var selected = grid ? grid.get_selected_children() : [];
            var selected_source_names = selected.map(function(r) { return r.name; });
            if (!selected_source_names.length) {
                frappe.msgprint(__('Выберите хотя бы один риск для расчёта.'));
                return;
            }
            if (!frm.aggregatedBudget) {
                frappe.msgprint({
                    title: __('Данные не загружены'),
                    message: __('Проблема при загрузке данных P&L')
                });
                return;
            }
            var result = buildReserveUpdates(frm, selected_source_names);
            var updates = result.updates;
            if (result.skipped) {
                if (frappe.boot.developer_mode) {
                    console.log('reserve: selected=%s updates=%s skipped=%s', selected_source_names.length, updates.length, result.skipped);
                }
            }
            if (!updates.length) {
                frappe.msgprint(__('Нет данных для сохранения. Проверьте выбранные риски (статья начисления, период, величина).'));
                return;
            }
            var parentResult = buildParentAdjustments(frm, updates);
            var parent_adjustments = parentResult.parent_adjustments || [];
            if (frappe.boot.developer_mode) {
                console.log('reserve: calling bulk_save_reserve_budgets project=%s updates=%s parent_adjustments=%s', frm.doc.name, updates.length, parent_adjustments.length);
            }
            frappe.call({
                method: 'dinext_risk_management.dinext_risk_management.bulk_save_reserve_budgets',
                args: {
                    project: frm.doc.name,
                    updates: updates,
                    parent_adjustments: parent_adjustments
                },
                freeze: true,
                freeze_message: __('Сохранение резерва...'),
                callback: function(r) {
                    if (r.exc) {
                        if (frappe.boot.developer_mode) console.error('reserve: bulk_save error', r.exc);
                        frappe.msgprint({ title: __('Ошибка'), message: r.exc && r.exc[0] ? r.exc[0] : __('Ошибка при сохранении резерва'), indicator: 'red' });
                        return;
                    }
                    var updated = (r.message && r.message.updated) || 0;
                    if (frappe.boot.developer_mode) console.log('reserve: bulk_save done updated=%s', updated);
                    frappe.show_alert({ message: __('Резерв рассчитан и добавлен в прогноз'), indicator: 'green' }, 5);
                    if (parent_adjustments.length > 0) {
                        var msg = __('Прогноз увеличен для следующих родительских статей до суммы дочерних: ') +
                            parent_adjustments.map(function(a) { return (a.account || ''); }).join(', ');
                        frappe.show_alert({ 
                            message: msg,
                            indicator:'yellow'
                         }, 5);                        
                    }
                    dialog.hide();
                    if (typeof load_budget_data === 'function') {
                        load_budget_data(frm, 'month', true);
                    } else if (cur_frm && cur_frm.doc && cur_frm.doc.name === frm.doc.name && cur_frm.aggregatedBudget && typeof load_budget_data === 'function') {
                        load_budget_data(cur_frm, 'month', true);
                    }
                }
            });
        },
        secondary_action_label: __('Закрыть'),
        secondary_action: function() {
            dialog.hide();
        }
    });
    dialog.show();
    var reserve_table = dialog.fields_dict.reserve_risks_table;
    if (reserve_table && reserve_table.grid) {
        var reserve_grid = reserve_table.grid;
        reserve_grid.wrapper
            .off('change.dinext_reserve_cell_title')
            .on('change.dinext_reserve_cell_title', function() {
                applyReserveRisksGridCellTitles(reserve_grid);
            });
        setTimeout(function() { applyReserveRisksGridCellTitles(reserve_grid); }, 0);
    }
}

frappe.ui.form.on('Project', {
    refresh: function(frm) {
        // Show "Включить резерв на риски" in "Рассчитать прогноз" menu only when project has risks with reserve
        dinext_projects.project_pl_forecast_menu = dinext_projects.project_pl_forecast_menu.filter(function(item) {
            return !item.__dinext_risk_reserve_forecast;
        });
        var risks = frm.doc.custom_project_risks || [];
        var has_reserve_risks = risks.some(function(r) { return r.contingency_reserve; });
        if (has_reserve_risks) {
            dinext_projects.project_pl_forecast_menu.push({
                label: __("Включить резерв на риски"),
                action: function(frm) { openReserveRisksDialog(frm); },
                __dinext_risk_reserve_forecast: true
            });
            dinext_projects.refresh_pl_forecast_dropdown(frm);
        }
        if (frm.doc.name && !frm.is_new()) {
            renderRiskMatrixWrapper(frm);
            bindRiskTabListenerOnce(frm);
        }
    }
});

frappe.ui.form.on('Project Risk', {
    custom_project_risks_add: function(frm) {
        renderRiskMatrixWrapper(frm);
    },
    custom_project_risks_remove: function(frm) {
        renderRiskMatrixWrapper(frm);
    },
    impact: function(frm) {
        renderRiskMatrixWrapper(frm);
    },
    probability: function(frm) {
        renderRiskMatrixWrapper(frm);
    }
});