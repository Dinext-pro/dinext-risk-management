// Ensure "Рассчитать прогноз" menu array exists for Dinext Projects (used in refresh to add our item conditionally)
frappe.provide("dinext_projects.project_pl_forecast_menu");
if (!Array.isArray(dinext_projects.project_pl_forecast_menu)) {
    dinext_projects.project_pl_forecast_menu = [];
}

/** Ensure P&L v2 grid is loaded (ProjectPlV2). */
function ensurePlV2ForReserve(frm) {
	return new Promise(function (resolve) {
		if (window.ProjectPlV2?.isPlV2Ready?.(frm)) {
			resolve(true);
			return;
		}
		const finish = function () {
			resolve(Boolean(frm.pl_v2?.rows?.length));
		};
		if (typeof with_pl_v2_ready === "function") {
			with_pl_v2_ready(frm, finish);
			return;
		}
		if (window.ProjectPlV2?.refresh) {
			Promise.resolve(window.ProjectPlV2.refresh(frm)).then(finish).catch(function () {
				resolve(false);
			});
			return;
		}
		resolve(false);
	});
}

/**
 * Future periods for reserve type.
 * reserve_period: "Месяц" | "Квартал" | "Год" | "Проект" | "Задача" | "Проект / Задача"
 */
function getReservePeriods(frm, reserve_period) {
	var periodType = (reserve_period || "Месяц").trim();
	var allPeriods = [];
	if (window.ProjectPlV2?.getPlDisplayPeriods) {
		allPeriods = window.ProjectPlV2.getPlDisplayPeriods(frm) || [];
	} else if (typeof get_budget_display_periods === "function") {
		allPeriods = get_budget_display_periods(frm, "month") || [];
	}
	if (!allPeriods.length) return [];
	var futurePeriods = allPeriods.filter(function (p) {
		return p.is_past === false;
	});
	if (periodType === "Месяц") {
		return futurePeriods.map(function (p) {
			return { year: p.year, month: p.month, key: p.key || p.year + "_" + p.month };
		});
	}
	if (periodType === "Квартал") {
		return futurePeriods
			.filter(function (p) {
				return p.month === 3 || p.month === 6 || p.month === 9 || p.month === 12;
			})
			.map(function (p) {
				return { year: p.year, month: p.month, key: p.key || p.year + "_" + p.month };
			});
	}
	if (periodType === "Год") {
		var seenY = {};
		return futurePeriods
			.filter(function (p) {
				if (p.month !== 12) return false;
				if (seenY[p.year]) return false;
				seenY[p.year] = true;
				return true;
			})
			.map(function (p) {
				return { year: p.year, month: p.month, key: p.key || p.year + "_" + p.month };
			});
	}
	if (
		periodType === "Проект / Задача" ||
		periodType === "Проект" ||
		periodType === "Задача"
	) {
		var last = futurePeriods[futurePeriods.length - 1];
		return last
			? [{ year: last.year, month: last.month, key: last.key || last.year + "_" + last.month }]
			: [];
	}
	return futurePeriods.map(function (p) {
		return { year: p.year, month: p.month, key: p.key || p.year + "_" + p.month };
	});
}

/** Reserve amounts per period from pl_v2 basis. */
function getReserveAmountsByPeriod(row, periods, frm) {
	var periodAmountMap = {};
	var method = (row.reserve_method || "").trim();
	if (method === "Сумма") {
		var amount = flt(row.reserve_amount, 2);
		for (var i = 0; i < periods.length; i++) {
			var p = periods[i];
			periodAmountMap[p.key || p.year + "_" + p.month] = amount;
		}
		return periodAmountMap;
	}
	if (method === "Процент") {
		var basisAccount = (row.reserve_basis_account || "").trim();
		var percent = flt(row.reserve_percent, 2);
		if (!basisAccount) return periodAmountMap;
		var reserveAccount = (row.reserve_account || "").trim();
		var dimensionsForBasis = [];
		var rows = frm.pl_v2?.rows || [];
		if (
			row.task &&
			window.ProjectPlV2?.accountAllowsTask?.(rows, reserveAccount)
		) {
			dimensionsForBasis.push({ doc: "Task", docname: row.task });
		}
		var basis =
			window.ProjectPlV2?.getBasisForecastMap?.(
				rows,
				basisAccount,
				dimensionsForBasis,
				periods
			) || {};
		for (var j = 0; j < periods.length; j++) {
			var per = periods[j];
			var k = per.key || per.year + "_" + per.month;
			periodAmountMap[k] = flt(((basis[k] || 0) * percent) / 100, 2);
		}
		return periodAmountMap;
	}
	return periodAmountMap;
}

/** Parent raise on pl_v2 tree (ProjectPlV2). */
function buildParentAdjustments(frm, updates) {
	if (window.ProjectPlV2?.buildParentAdjustments) {
		return window.ProjectPlV2.buildParentAdjustments(frm, updates);
	}
	return { parent_adjustments: [], adjusted_parents: [] };
}

/**
 * Build updates for bulk_save_reserve_budgets from selected risk names (pl_v2).
 */
function buildReserveUpdates(frm, selected_source_names) {
	var risks = frm.doc.custom_project_risks || [];
	var updates = [];
	var skipped = 0;
	var treeRows = frm.pl_v2?.rows || [];
	for (var n = 0; n < selected_source_names.length; n++) {
		var name = selected_source_names[n];
		var row = risks.filter(function (r) {
			return r.name === name;
		})[0];
		if (!row) {
			skipped++;
			continue;
		}
		if (!row.contingency_reserve || row.status === "Closed") {
			skipped++;
			continue;
		}
		var reserveAccount = (row.reserve_account || "").trim();
		if (!reserveAccount) {
			skipped++;
			continue;
		}
		var reservePeriod = (row.reserve_period || "Месяц").trim();
		var periods = getReservePeriods(frm, reservePeriod);
		if (!periods.length) {
			skipped++;
			continue;
		}
		var dimensions = [];
		if (
			row.task &&
			window.ProjectPlV2?.accountAllowsTask?.(treeRows, reserveAccount)
		) {
			dimensions.push({ doc: "Task", docname: row.task });
		}
		dimensions.push({ doc: "Project Risk", docname: row.name || name });
		var periodAmountMap = getReserveAmountsByPeriod(row, periods, frm);
		var hasPositive = Object.keys(periodAmountMap).some(function (k) {
			return periodAmountMap[k] > 0;
		});
		if (!hasPositive) {
			skipped++;
			continue;
		}
		updates.push({
			account: reserveAccount,
			dimensions: dimensions,
			period_amount_map: periodAmountMap,
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
            frappe.dom.freeze(__('Загрузка данных P&L...'));
            ensurePlV2ForReserve(frm).then(function(ready) {
                frappe.dom.unfreeze();
                if (!ready) {
                    frappe.msgprint({
                        title: __('Данные не загружены'),
                        message: __('Откройте вкладку P&L и дождитесь загрузки таблицы, затем повторите расчёт резерва.')
                    });
                    return;
                }
                var result = buildReserveUpdates(frm, selected_source_names);
                var updates = result.updates;
                if (result.skipped && frappe.boot.developer_mode) {
                    console.log('reserve: selected=%s updates=%s skipped=%s', selected_source_names.length, updates.length, result.skipped);
                }
                if (!updates.length) {
                    frappe.msgprint(__('Нет данных для сохранения. Проверьте выбранные риски (статья начисления, период, величина).'));
                    return;
                }
                var parentResult = buildParentAdjustments(frm, updates);
                var parent_adjustments = parentResult.parent_adjustments || [];
                if (frappe.boot.developer_mode) {
                    console.log('reserve: bulk_save project=%s updates=%s parents=%s', frm.doc.name, updates.length, parent_adjustments.length);
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
                            frappe.msgprint({ title: __('Ошибка'), message: r.exc && r.exc[0] ? r.exc[0] : __('Ошибка при сохранении резерва'), indicator: 'red' });
                            return;
                        }
                        frappe.show_alert({ message: __('Резерв рассчитан и добавлен в прогноз'), indicator: 'green' }, 5);
                        if (parent_adjustments.length > 0) {
                            var msg = __('Прогноз увеличен для следующих родительских статей до суммы дочерних: ') +
                                parent_adjustments.map(function(a) { return (a.account || ''); }).join(', ');
                            frappe.show_alert({ message: msg, indicator: 'yellow' }, 5);
                        }
                        dialog.hide();
                        if (window.ProjectPlV2?.refresh) {
                            window.ProjectPlV2.refresh(frm);
                        } else if (typeof with_pl_v2_ready === 'function') {
                            with_pl_v2_ready(frm, function () {});
                        }
                    }
                });
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