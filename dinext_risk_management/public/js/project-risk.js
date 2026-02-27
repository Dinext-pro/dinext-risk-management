// Project Risk Matrix - Interactive heatmap with ECharts
// ECharts: loaded from CDN on first use

var _lastRiskMatrixForm = null;

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

var DONUT_CHART_TYPES = [
    { value: 'category', label: __('По категориям') },
    { value: 'status', label: __('По статусам') },
    { value: 'priority', label: __('По приоритетам') },
    { value: 'impact', label: __('По влиянию') },
    { value: 'probability', label: __('По вероятности') },
    { value: 'level', label: __('По уровням') },
    { value: 'strategy', label: __('По стратегии') },
    { value: 'owner_person', label: __('По владельцам') },
    { value: 'responsible_person', label: __('По ответственным') }
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

function clearRiskFilter(frm) {
    frm._risk_matrix_selected_cell = null;
    applyAllRiskFilters(frm);
}

function getDonutData(frm, fieldname) {
    var risks = frm.doc.custom_project_risks || [];
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

function addClearFilterButton(frm) {
    /*var field = frm.fields_dict['custom_risk_matrix'];
    if (!field || !field.$wrapper) return;
    if (field.$wrapper.find('.risk-matrix-clear-filter-btn').length) return;
    var btn = $('<button class="btn btn-sm btn-default risk-matrix-clear-filter-btn" style="margin-bottom:10px;">' + __('Сбросить фильтр') + '</button>');
    btn.on('click', function() {
        clearRiskFilter(frm);
        frm._risk_matrix_selected_cell = null;
        applyMatrixSelectionHighlight(frm);
    });
    field.$wrapper.prepend(btn);/* */
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
        tooltip: {
            trigger: 'item',
            formatter: function(params) {
                var p = params;
                return (p.name || '') + ': ' + (p.value || 0) + ' (' + (p.percent || 0).toFixed(1) + '%)';
            }
        },
        series: [{
            type: 'pie',
            radius: '70%',
            center: ['50%', '50%'],
            data: seriesData,
            label: {
                color: textColor,
                formatter: function(params) {
                    var n = params.name;
                    if (n && n.length > 18) n = n.slice(0, 16) + '…';
                    return (n || '') + '\n' + (params.value || 0);
                }
            },
            emphasis: { scale: true, scaleSize: 10, itemStyle: { borderColor: '#333', borderWidth: 2 } },
            selectedOffset: 12
        }]
    };
}

function getDonutChartType(frm) {
    var sel = frm._donut_chart_type_select;
    return (sel && sel.length && sel.val()) ? sel.val() : 'category';
}

function updateDonutChart(frm) {
    var chart = frm._risk_donut_chart;
    var container = frm._risk_donut_container;
    if (!chart || !container || !container.length) return;
    var fieldname = getDonutChartType(frm);
    var data = getDonutData(frm, fieldname);
    var selectedValue = (frm._donut_selected && frm._donut_selected.fieldname === fieldname) ? frm._donut_selected.value : null;
    var option = buildDonutOption(frm, data, selectedValue);
    chart.setOption(option, { replaceMerge: ['series'] });
}

function updateDonutSelectionOnly(frm) {
    var chart = frm._risk_donut_chart;
    var container = frm._risk_donut_container;
    if (!chart || !container || !container.length) return;
    var fieldname = getDonutChartType(frm);
    var data = getDonutData(frm, fieldname);
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
                var it = matrixData[idx];
                return '<strong>' + (it.probability || '') + ' × ' + (it.impact || '') + '</strong><br/>' +
                    (__('Уровень') + ': ' + (it.level || '-') + '<br/>') +
                    (__('Количество рисков') + ': ' + (it.count || 0));
            }
        },
        grid: {
            left: '68px',
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
                nameGap: 35,
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
        var it = matrixData[params.dataIndex];
        if (!it) return;
        var sel = frm._risk_matrix_selected_cell;
        if (sel && sel.probability === it.probability && sel.impact === it.impact) {
            frm._risk_matrix_selected_cell = null;
        } else {
            frm._risk_matrix_selected_cell = { probability: it.probability, impact: it.impact };
            frappe.show_alert({ message: __('Отфильтровано по: Вероятность: {0} × Влияние: {1}', [it.probability, it.impact]), indicator: 'blue' }, 3);
        }
        applyAllRiskFilters(frm);
        applyMatrixSelectionHighlight(frm);
    });
    frm._risk_matrix_chart = chart;

    var donutPanel = $('<div class="risk-donut-panel"></div>');
    var formGroup = $('<div class="form-group"></div>');
    //var label = $('<label class="control-label">' + __('Вид графика') + '</label>');
    var select = $('<select class="form-control input-sm"></select>');
    select.attr('aria-label', __('Вид графика'));
    for (var di = 0; di < DONUT_CHART_TYPES.length; di++) {
        var opt = DONUT_CHART_TYPES[di];
        select.append($('<option></option>').attr('value', opt.value).text(opt.label));
    }
    frm._donut_chart_type_select = select;
    if (!frm._donut_chart_type) frm._donut_chart_type = 'category';
    select.val(frm._donut_chart_type);
    formGroup.append(select);
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
    select.on('change', function() {
        frm._donut_chart_type = select.val();
        frm._donut_selected = null;
        updateDonutChart(frm);
        applyAllRiskFilters(frm);
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
        var matrixData = buildMatrixData(frm, dims.impacts, dims.probabilities, dims.levels);
        renderRiskMatrix(frm, matrixData, dims.impacts, dims.probabilities);
        addClearFilterButton(frm);
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

frappe.ui.form.on('Project', {
    refresh: function(frm) {
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