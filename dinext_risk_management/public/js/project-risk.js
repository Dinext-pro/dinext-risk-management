// Project Risk Matrix - Interactive heatmap with ECharts
// ECharts: loaded from CDN on first use

var _lastRiskMatrixForm = null;

// Ensure "Рассчитать прогноз" menu array exists for Dinext Projects (used in refresh to add our item conditionally)
frappe.provide("dinext_projects.project_pl_forecast_menu");
if (!Array.isArray(dinext_projects.project_pl_forecast_menu)) {
    dinext_projects.project_pl_forecast_menu = [];
}

function loadEcharts() {
    if (window.echarts) return Promise.resolve();
    return new Promise(function(resolve, reject) {
        frappe.require(['/assets/dinext_common/js/echarts.min.js'], function() {
            if (window.echarts) {
                resolve();
            } else {
                reject(new Error('Failed to load ECharts'));
            }
        });
    });
}

async function loadRiskDimensions() {
    var lists = await Promise.all([
        frappe.db.get_list('Risk Impact', { fields: ['name', 'value'], filters: { enabled: 1 }, order_by: 'value asc' }),
        frappe.db.get_list('Risk Probability', { fields: ['name', 'value'], filters: { enabled: 1 }, order_by: 'value asc' }),
        frappe.db.get_list('Risk Level', { fields: ['name', 'value', 'color_light_theme', 'color_dark_theme'], filters: { enabled: 1 }, order_by: 'value desc' })
    ]);
    return { impacts: lists[0] || [], probabilities: lists[1] || [], levels: lists[2] || [] };
}

function isDarkTheme() {
    var theme = document.documentElement.getAttribute('data-theme');
    if (theme === 'dark' || theme === 'light') return theme === 'dark';
    var mode = document.documentElement.getAttribute('data-theme-mode');
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function getColor(level) {
    if (!level) return '#cccccc';
    var dark = isDarkTheme();
    var c = dark ? (level.color_dark_theme || level.color_light_theme) : (level.color_light_theme || level.color_dark_theme);
    return c || '#cccccc';
}

function getContrastColor(hex) {
    if (!hex || typeof hex !== 'string') return '#000';
    var h = hex.replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return '#000';
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    var luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000' : '#fff';
}

function buildMatrixData(frm, impacts, probabilities, levels) {
    var matrix = [];
    var risks = frm.doc.custom_project_risks || [];
    for (var pi = 0; pi < probabilities.length; pi++) {
        var p = probabilities[pi];
        for (var ii = 0; ii < impacts.length; ii++) {
            var i = impacts[ii];
            var score = (p.value || 0) * (i.value || 0);
            var level = null;
            for (var li = 0; li < levels.length; li++) {
                if (Number(levels[li].value) <= score) { level = levels[li]; break; }
            }
            if (!level && levels.length) level = levels[levels.length - 1];
            var count = 0;
            for (var ri = 0; ri < risks.length; ri++) {
                if (risks[ri].probability === p.name && risks[ri].impact === i.name) count++;
            }
            matrix.push({
                probability: p.name,
                probability_value: Number(p.value) || 0,
                impact: i.name,
                impact_value: Number(i.value) || 0,
                score: score,
                level: level ? level.name : '',
                color: getColor(level),
                count: count
            });
        }
    }
    return matrix;
}

function buildMatrixDataFromRisks(risks, impacts, probabilities, levels) {
    var matrix = [];
    risks = risks || [];
    for (var pi = 0; pi < probabilities.length; pi++) {
        var p = probabilities[pi];
        for (var ii = 0; ii < impacts.length; ii++) {
            var i = impacts[ii];
            var score = (p.value || 0) * (i.value || 0);
            var level = null;
            for (var li = 0; li < levels.length; li++) {
                if (Number(levels[li].value) <= score) { level = levels[li]; break; }
            }
            if (!level && levels.length) level = levels[levels.length - 1];
            var count = 0;
            for (var ri = 0; ri < risks.length; ri++) {
                if (risks[ri].probability === p.name && risks[ri].impact === i.name) count++;
            }
            matrix.push({
                probability: p.name,
                probability_value: Number(p.value) || 0,
                impact: i.name,
                impact_value: Number(i.value) || 0,
                score: score,
                level: level ? level.name : '',
                color: getColor(level),
                count: count
            });
        }
    }
    return matrix;
}

var DONUT_CHART_TYPES = [
    { value: 'category', label: __('Категория') },
    { value: 'status', label: __('Статус') },
    { value: 'priority', label: __('Приоритет') },
    { value: 'impact', label: __('Влияние') },
    { value: 'probability', label: __('Вероятность') },
    { value: 'level', label: __('Уровень') },
    { value: 'strategy', label: __('Стратегия') },
    { value: 'owner_person', label: __('Владелец') },
    { value: 'responsible_person', label: __('Ответственный') }
];

/** Muted but clearly colored palette for pie/donut — light theme */
var DONUT_CHART_COLORS_LIGHT = [
    '#4a7aa8', '#3d8f7a', '#b88a4a', '#7a5a9e', '#b06a6a',
    '#4a9a4a', '#5a5aaa', '#7a9a48', '#5a7aaa', '#aa7a4a'
];

/** Muted but clearly colored palette for pie/donut — dark theme */
var DONUT_CHART_COLORS_DARK = [
    '#6a9cc4', '#5ab09a', '#d4a858', '#9a7ab8', '#c88a8a',
    '#6aba6a', '#7a7ac8', '#8ab068', '#7a8ac8', '#c89a6a'
];

var EMPTY_LABEL = __('Не определено');

function applyAllRiskFilters(frm) {
    var fd = frm.fields_dict['custom_project_risks'];
    if (!fd || !fd.grid || !fd.grid.grid_rows) return;
    var rows = fd.grid.grid_rows;
    var matrixCell = frm._risk_matrix_selected_cell || null;
    var donutSel = frm._donut_selected || null;
    for (var i = 0; i < rows.length; i++) {
        var d = rows[i].doc;
        var passMatrix = !matrixCell || (d.probability === matrixCell.probability && d.impact === matrixCell.impact);
        var passDonut = !donutSel || (String(d[donutSel.fieldname] || '') === String(donutSel.value || ''));
        rows[i].wrapper[passMatrix && passDonut ? 'show' : 'hide']();
    }
}

/** Return subset of custom_project_risks filtered by matrix and/or donut selection. */
function getFilteredRisks(frm, byMatrix, byDonut) {
    var risks = frm.doc.custom_project_risks || [];
    if (!byMatrix && !byDonut) return risks;
    var out = [];
    var matrixCell = byMatrix ? (frm._risk_matrix_selected_cell || null) : null;
    var donutSel = byDonut ? (frm._donut_selected || null) : null;
    for (var i = 0; i < risks.length; i++) {
        var d = risks[i];
        var passMatrix = !matrixCell || (d.probability === matrixCell.probability && d.impact === matrixCell.impact);
        var passDonut = !donutSel || (String(d[donutSel.fieldname] || '') === String(donutSel.value || ''));
        if (passMatrix && passDonut) out.push(d);
    }
    return out;
}

function clearRiskFilter(frm) {
    frm._risk_matrix_selected_cell = null;
    applyAllRiskFilters(frm);
}

function getDonutData(frm, fieldname, risks) {
    if (risks === undefined) risks = frm.doc.custom_project_risks || [];
    var counts = {};
    for (var i = 0; i < risks.length; i++) {
        var v = risks[i][fieldname];
        var key = (v === undefined || v === null || v === '') ? EMPTY_LABEL : String(v);
        counts[key] = (counts[key] || 0) + 1;
    }
    var data = [];
    for (var k in counts) {
        data.push({ value: counts[k], name: k });
    }
    return data.sort(function(a, b) { return b.value - a.value; });
}

function darkenColor(hex, factor) {
    if (!hex || typeof hex !== 'string') return hex;
    factor = factor != null ? factor : 0.8;
    var h = hex.replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return hex;
    var r = Math.round(parseInt(h.slice(0, 2), 16) * factor);
    var g = Math.round(parseInt(h.slice(2, 4), 16) * factor);
    var b = Math.round(parseInt(h.slice(4, 6), 16) * factor);
    return '#' + [r, g, b].map(function(x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
}

function buildHeatmapSeriesData(matrixData, selectedCell) {
    var data = [];
    for (var i = 0; i < matrixData.length; i++) {
        var m = matrixData[i];
        var contrast = getContrastColor(m.color);
        var labelColor = m.count === 0
            ? (contrast === '#fff' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)')
            : contrast;
        var isSelected = selectedCell && selectedCell.probability === m.probability && selectedCell.impact === m.impact;
        var cellColor = isSelected ? darkenColor(m.color, ( isDarkTheme() ? 1.35 : 0.85 ) ) : m.color;
        var itemStyle = { color: cellColor };
        if (isSelected) {
            itemStyle.borderColor = '#333';
            itemStyle.borderWidth = 1;
        }
        data.push({
            value: [m.impact, m.probability, m.count],
            itemStyle: itemStyle,
            label: { color: labelColor }
        });
    }
    return data;
}

function applyMatrixSelectionHighlight(frm) {
    var chart = frm._risk_matrix_chart;
    var matrixData = frm._risk_matrix_data;
    if (!chart || !matrixData) return;
    var selectedCell = frm._risk_matrix_selected_cell || null;
    var data = buildHeatmapSeriesData(matrixData, selectedCell);
    chart.setOption({ series: [{ data: data }] });
}

function updateMatrixChartFromDonutFilter(frm) {
    var chart = frm._risk_matrix_chart;
    var dims = frm._risk_matrix_dims;
    if (!chart || !dims) return;
    var risks = frm._donut_selected
        ? getFilteredRisks(frm, false, true)
        : (frm.doc.custom_project_risks || []);
    var matrixData = buildMatrixDataFromRisks(risks, dims.impacts, dims.probabilities, dims.levels);
    frm._risk_matrix_data = matrixData;
    var selectedCell = frm._risk_matrix_selected_cell || null;
    var data = buildHeatmapSeriesData(matrixData, selectedCell);
    chart.setOption({
        series: [{
            data: data,
            animation: true,
            animationDuration: 350
        }]
    });
}

function buildDonutOption(frm, data, selectedValue) {
    var textColor = isDarkTheme() ? '#e0e0e0' : '#374151';
    var seriesData = (data || []).map(function(item, idx) {
        var isSelected = selectedValue !== null && selectedValue !== undefined && String(item.name) === String(selectedValue);
        return {
            value: item.value,
            name: item.name,
            selected: isSelected,
            itemStyle: isSelected ? { borderColor: '#333', borderWidth: 2 } : undefined
        };
    });
    return {
        color: isDarkTheme() ? DONUT_CHART_COLORS_DARK : DONUT_CHART_COLORS_LIGHT,
        tooltip: {
            trigger: 'item',
            formatter: function(params) {
                var p = params;
                return (p.name || '') + ': ' + (p.value || 0) + ' (' + (p.percent || 0).toFixed(1) + '%)';
            }
        },
        labelLayout: {
            hideOverlap: false,
            moveOverlap: 'shiftY',
            bleedMargin: 8
        },
        series: [{
            type: 'pie',
            radius: ['45%', '65%'],
            center: ['50%', '50%'],
            data: seriesData,
            animation: true,
            animationDuration: 350,
            avoidLabelOverlap: true,
            labelLine: {
                show: true,
                length: 8,
                length2: 12
            },
            label: {
                color: textColor,
                formatter: function(params) {
                    var n = params.name;
                    if (n && n.length > 22) n = n.slice(0, 20) + '…';
                    return (n || '') + '\n' + (params.value || 0);
                }
            },
            emphasis: { scale: true, scaleSize: 10, itemStyle: { borderColor: '#333', borderWidth: 2 } },
            selectedOffset: 12
        }]
    };
}

function getDonutChartType(frm) {
    var ctrl = frm._donut_chart_type_control;
    return (ctrl && ctrl.get_value) ? ctrl.get_value() : (frm._donut_chart_type || 'category');
}

function updateDonutChart(frm) {
    var chart = frm._risk_donut_chart;
    var container = frm._risk_donut_container;
    if (!chart || !container || !container.length) return;
    var fieldname = getDonutChartType(frm);
    var risks = frm._risk_matrix_selected_cell
        ? getFilteredRisks(frm, true, false)
        : undefined;
    var data = getDonutData(frm, fieldname, risks);
    var selectedValue = (frm._donut_selected && frm._donut_selected.fieldname === fieldname) ? frm._donut_selected.value : null;
    var option = buildDonutOption(frm, data, selectedValue);
    chart.setOption(option, { replaceMerge: ['series'] });
}

function updateDonutSelectionOnly(frm) {
    var chart = frm._risk_donut_chart;
    var container = frm._risk_donut_container;
    if (!chart || !container || !container.length) return;
    var fieldname = getDonutChartType(frm);
    var risks = frm._risk_matrix_selected_cell
        ? getFilteredRisks(frm, true, false)
        : undefined;
    var data = getDonutData(frm, fieldname, risks);
    var selectedValue = (frm._donut_selected && frm._donut_selected.fieldname === fieldname) ? frm._donut_selected.value : null;
    var seriesData = (data || []).map(function(item) {
        var isSelected = selectedValue !== null && selectedValue !== undefined && String(item.name) === String(selectedValue);
        return {
            value: item.value,
            name: item.name,
            selected: isSelected,
            itemStyle: isSelected ? { borderColor: '#333', borderWidth: 2 } : undefined
        };
    });
    chart.setOption({ series: [{ data: seriesData }] });
    chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
    var selectedIndex = -1;
    for (var i = 0; i < seriesData.length; i++) {
        if (seriesData[i].selected) { selectedIndex = i; break; }
    }
    if (selectedIndex >= 0) {
        chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: selectedIndex });
    }
}

function onDonutClick(frm, params) {
    if (!params || !params.name) return;
    var fieldname = getDonutChartType(frm);
    var value = params.name === EMPTY_LABEL ? '' : params.name;
    var sel = frm._donut_selected;
    if (sel && sel.fieldname === fieldname && String(sel.value || '') === String(value || '')) {
        frm._donut_selected = null;
    } else {
        frm._donut_selected = { fieldname: fieldname, value: value };
    }
    applyAllRiskFilters(frm);
    updateDonutSelectionOnly(frm);
    updateMatrixChartFromDonutFilter(frm);
}

function renderRiskMatrix(frm, matrixData, impacts, probabilities) {
    var field = frm.fields_dict['custom_risk_matrix'];
    if (!field || !field.$wrapper) return;
    if (frm._risk_matrix_chart) {
        try { frm._risk_matrix_chart.dispose(); } catch (e) {}
        frm._risk_matrix_chart = null;
    }
    if (frm._risk_donut_chart) {
        try { frm._risk_donut_chart.dispose(); } catch (e) {}
        frm._risk_donut_chart = null;
    }
    if (frm._risk_matrix_resize_observer) {
        frm._risk_matrix_resize_observer.disconnect();
        frm._risk_matrix_resize_observer = null;
    }
    field.$wrapper.find('.risk-matrix-row').remove();
    var row = $('<div class="risk-matrix-row"></div>');
    var leftCol = $('<div></div>');
    var chartDiv = $('<div class="risk-matrix-chart-container"></div>');
    leftCol.append(chartDiv);
    row.append(leftCol);
    var axisTextColor = isDarkTheme() ? '#e0e0e0' : '#374151';
    var chart = echarts.init(chartDiv[0]);
    frm._risk_matrix_data = matrixData;
    var selectedCell = frm._risk_matrix_selected_cell || null;
    var data = buildHeatmapSeriesData(matrixData, selectedCell);
    var maxCount = 0;
    for (var j = 0; j < matrixData.length; j++) {
        if (matrixData[j].count > maxCount) maxCount = matrixData[j].count;
    }
    var option = {
        tooltip: {
            formatter: function(params) {
                var idx = params.dataIndex;
                var data = frm._risk_matrix_data;
                var it = data && data[idx];
                if (!it) return '';
                return '<strong>' + (it.probability || '') + ' × ' + (it.impact || '') + '</strong><br/>' +
                    (__('Уровень') + ': ' + (it.level || '-') + '<br/>') +
                    (__('Количество рисков') + ': ' + (it.count || 0));
            }
        },
        grid: {
            left: '28px',
            right: '58px',
            top: '28px',
            bottom: '50px',
            containLabel: true
        },
        xAxis: {
            type: 'category',
            data: impacts.map(function(x) { return x.name; }),
            name: __('Влияние'),
            nameLocation: 'middle',
            nameGap: 30,
            nameTextStyle: { fontSize: 12, color: axisTextColor },
            axisLabel: { fontSize: 10, color: axisTextColor, interval: 0, margin: 10 },
            splitArea: { show: true }
        },
        yAxis: [
            {
                type: 'category',
                data: probabilities.map(function(x) { return x.name; }),
                name: __('Вероятность'),
                nameLocation: 'middle',
                nameGap: 10,
                nameTextStyle: { fontSize: 12, color: axisTextColor },
                axisLabel: { show: false },
                splitArea: { show: true }
            },
            {
                type: 'category',
                data: probabilities.map(function(x) { return x.name; }),
                position: 'right',
                name: '',
                nameLocation: 'middle',
                nameGap: 40,
                nameTextStyle: { fontSize: 12, color: axisTextColor },
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { show: true, fontSize: 11, color: axisTextColor, margin: 10 },
                splitLine: { show: false },
                splitArea: { show: false }
            }
        ],
        series: [{
            name: __('Риски'),
            type: 'heatmap',
            animation: false,
            data: data,
            // Показываем только количество, нули затемнены
            label: { 
                show: true, 
                formatter: function(params) {
                    var v = params.value;
                    return Array.isArray(v) ? v[2] : (v && v[2] !== undefined ? v[2] : '');
                },
                fontSize: 14,
                //fontWeight: 'bold'
            },
            emphasis: { itemStyle: { borderColor: '#333', borderWidth: 1 } }
        }]
    };
    chart.setOption(option);
    chart.on('click', function(params) {
        var data = frm._risk_matrix_data;
        var it = data && data[params.dataIndex];
        if (!it) return;
        var sel = frm._risk_matrix_selected_cell;
        if (sel && sel.probability === it.probability && sel.impact === it.impact) {
            frm._risk_matrix_selected_cell = null;
        } else {
            frm._risk_matrix_selected_cell = { probability: it.probability, impact: it.impact };
            //frappe.show_alert({ message: __('Отфильтровано по: Вероятность: {0} × Влияние: {1}', [it.probability, it.impact]), indicator: 'blue' }, 3);
        }
        applyAllRiskFilters(frm);
        applyMatrixSelectionHighlight(frm);
        updateDonutChart(frm);
    });
    frm._risk_matrix_chart = chart;

    var donutPanel = $('<div class="risk-donut-panel"></div>');
    var formGroup = $('<div class="form-group"></div>');
    if (!frm._donut_chart_type) frm._donut_chart_type = 'category';
    var donutChartTypeControl = frappe.ui.form.make_control({
        parent: formGroup,
        doctype: 'Project',
        docname: frm.doc.name,
        df: {
            label: '',
            fieldname: '_donut_chart_type',
            fieldtype: 'Select',
            options: DONUT_CHART_TYPES,
            input_class: 'input-sm',
            change: function() {
                frm._donut_chart_type = this.get_value();
                frm._donut_selected = null;
                updateDonutChart(frm);
                applyAllRiskFilters(frm);
                updateMatrixChartFromDonutFilter(frm);
            }
        },
        value: frm._donut_chart_type || 'category',
        render_input: true,
        only_input: true
    });
    frm._donut_chart_type_control = donutChartTypeControl;
    donutPanel.append(formGroup);
    var donutContainer = $('<div class="risk-donut-chart-container"></div>');
    donutPanel.append(donutContainer);
    row.append(donutPanel);
    field.$wrapper.append(row);

    frm._risk_donut_container = donutContainer;
    var donutChart = echarts.init(donutContainer[0]);
    frm._risk_donut_chart = donutChart;
    updateDonutChart(frm);
    donutChart.on('click', function(params) {
        onDonutClick(frm, params);
    });

    var resizeHandler = function() {
        if (frm._risk_matrix_chart) frm._risk_matrix_chart.resize();
        if (frm._risk_donut_chart) frm._risk_donut_chart.resize();
    };
    if (frm._risk_matrix_resize_handler) {
        window.removeEventListener('resize', frm._risk_matrix_resize_handler);
    }
    frm._risk_matrix_resize_handler = resizeHandler;
    window.addEventListener('resize', resizeHandler);
    setTimeout(function() {
        if (frm._risk_donut_chart) frm._risk_donut_chart.resize();
    }, 50);
    if (typeof ResizeObserver !== 'undefined' && donutContainer && donutContainer[0]) {
        frm._risk_matrix_resize_observer = new ResizeObserver(function() {
            if (frm._risk_matrix_chart) frm._risk_matrix_chart.resize();
            if (frm._risk_donut_chart) frm._risk_donut_chart.resize();
        });
        frm._risk_matrix_resize_observer.observe(donutContainer[0]);
    }
}

function ensureThemeObserver() {
    if (window._risk_theme_observer_bound) return;
    window._risk_theme_observer_bound = true;
    var observer = new MutationObserver(function() {
        if (_lastRiskMatrixForm && _lastRiskMatrixForm._risk_matrix_chart) {
            renderRiskMatrixWrapper(_lastRiskMatrixForm);
        }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

async function renderRiskMatrixWrapper(frm) {
    var field = frm.fields_dict['custom_risk_matrix'];
    if (!field || !field.$wrapper || !field.$wrapper.length) return;
    try {
        await loadEcharts();
        var dims = await loadRiskDimensions();
        if (!dims.impacts.length || !dims.probabilities.length) {
            field.$wrapper.find('.risk-matrix-row').remove();
            field.$wrapper.append('<p class="text-muted">' + __('Нет настроенных уровней влияния или вероятности') + '</p>');
            return;
        }
        frm._risk_matrix_dims = dims;
        var matrixData = buildMatrixData(frm, dims.impacts, dims.probabilities, dims.levels);
        renderRiskMatrix(frm, matrixData, dims.impacts, dims.probabilities);
        _lastRiskMatrixForm = frm;
        ensureThemeObserver();
    } catch (e) {
        console.error('Project Risk Matrix error:', e);
        field.$wrapper.find('.risk-matrix-row').remove();
        field.$wrapper.append('<p class="text-danger">' + __('Ошибка загрузки матрицы рисков') + ': ' + (e.message || e) + '</p>');
    }
}

function bindRiskTabListenerOnce(frm) {
    if (frm._risk_tab_listener_bound) return;
    var $wrapper = frm.$wrapper || (frm.wrapper && $(frm.wrapper));
    if (!$wrapper || !$wrapper.length) return;
    $wrapper.on('shown.bs.tab', '[data-fieldname="custom_риски"]', function() {
        if (frm._risk_matrix_chart) {
            setTimeout(function() {
                if (frm._risk_matrix_chart) frm._risk_matrix_chart.resize();
                if (frm._risk_donut_chart) frm._risk_donut_chart.resize();
            }, 50);
        } else {
            renderRiskMatrixWrapper(frm);
        }
    });
    frm._risk_tab_listener_bound = true;
}

/** Build sortable key for dimensions (matches backend dimensions_key). */
function reserveDimensionsKey(dimensions) {
    if (!dimensions || !dimensions.length) return '';
    var parts = dimensions
        .filter(function(d) { return d && d.doc; })
        .map(function(d) { return d.doc + ':' + (d.docname || ''); })
        .sort();
    return parts.join('|');
}

/** Return true if dimensions arrays match (same doc:docname set). */
function reserveDimensionsEqual(dim1, dim2) {
    return reserveDimensionsKey(dim1) === reserveDimensionsKey(dim2);
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
    if (!allPeriods.length && frm.doc.expected_start_date && frm.doc.expected_end_date) {
        var start = frappe.datetime.str_to_obj(frm.doc.expected_start_date);
        var end = frappe.datetime.str_to_obj(frm.doc.expected_end_date);
        var monthStart = frappe.datetime.str_to_obj(frappe.datetime.month_start());
        var current = start;
        while (frappe.datetime.obj_to_str(current) <= frappe.datetime.obj_to_str(end)) {
            var y = current.getFullYear();
            var m = current.getMonth() + 1;
            var isPast = (y < monthStart.getFullYear()) || (y === monthStart.getFullYear() && m < monthStart.getMonth() + 1);
            allPeriods.push({ year: y, month: m, is_past: isPast });
            current = frappe.datetime.str_to_obj(frappe.datetime.add_months(current, 1));
        }
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
            if (frappe.boot.developer_mode) {
                console.log('reserve: calling bulk_save_reserve_budgets project=%s updates=%s', frm.doc.name, updates.length);
            }
            frappe.call({
                method: 'dinext_risk_management.dinext_risk_management.bulk_save_reserve_budgets',
                args: {
                    project: frm.doc.name,
                    updates: updates
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