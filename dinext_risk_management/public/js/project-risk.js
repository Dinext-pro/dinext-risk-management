// Project Risk Matrix - Interactive heatmap with ECharts
// ECharts: loaded from CDN on first use

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

function getColor(level) {
    if (!level) return '#cccccc';
    var isDark = document.body.classList.contains('dark') || (document.documentElement.getAttribute('data-theme-mode') === 'dark');
    var c = isDark ? (level.color_dark_theme || level.color_light_theme) : (level.color_light_theme || level.color_dark_theme);
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

function filterRiskTable(frm, probability, impact) {
    var fd = frm.fields_dict['custom_project_risks'];
    if (!fd || !fd.grid || !fd.grid.grid_rows) return;
    var rows = fd.grid.grid_rows;
    for (var i = 0; i < rows.length; i++) {
        rows[i].wrapper.show();
    }
    if (probability && impact) {
        for (var j = 0; j < rows.length; j++) {
            var d = rows[j].doc;
            if (d.probability !== probability || d.impact !== impact) {
                rows[j].wrapper.hide();
            }
        }
        frappe.show_alert({ message: __('Отфильтровано по: Вероятность: {0} × Влияние: {1}', [probability, impact]), indicator: 'blue' });
    }
}

function clearRiskFilter(frm) {
    var fd = frm.fields_dict['custom_project_risks'];
    if (!fd || !fd.grid || !fd.grid.grid_rows) return;
    var rows = fd.grid.grid_rows;
    for (var i = 0; i < rows.length; i++) {
        rows[i].wrapper.show();
    }
}

function addClearFilterButton(frm) {
    var field = frm.fields_dict['custom_risk_matrix'];
    if (!field || !field.$wrapper) return;
    if (field.$wrapper.find('.risk-matrix-clear-filter-btn').length) return;
    var btn = $('<button class="btn btn-sm btn-default risk-matrix-clear-filter-btn" style="margin-bottom:10px;">' + __('Сбросить фильтр') + '</button>');
    btn.on('click', function() { clearRiskFilter(frm); });
    field.$wrapper.prepend(btn);
}

function renderRiskMatrix(frm, matrixData, impacts, probabilities) {
    var field = frm.fields_dict['custom_risk_matrix'];
    if (!field || !field.$wrapper) return;
    if (frm._risk_matrix_chart) {
        try { frm._risk_matrix_chart.dispose(); } catch (e) {}
        frm._risk_matrix_chart = null;
    }
    field.$wrapper.find('.risk-matrix-chart-container').remove();
    var isDark = document.body.classList.contains('dark') || (document.documentElement.getAttribute('data-theme-mode') === 'dark');
    var axisTextColor = isDark ? '#e0e0e0' : '#374151';
    var chartDiv = $('<div class="risk-matrix-chart-container" style="width:min(54vw, 864px); aspect-ratio: 2.7; max-width:960px;"></div>');
    field.$wrapper.append(chartDiv);
    var chart = echarts.init(chartDiv[0]);
    var data = [];
    for (var i = 0; i < matrixData.length; i++) {
        var m = matrixData[i];
        var contrast = getContrastColor(m.color);
        var labelColor = m.count === 0
            ? (contrast === '#fff' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.35)')
            : contrast;
        data.push({
            value: [m.impact, m.probability, m.count],
            itemStyle: { color: m.color },
            label: { color: labelColor }
        });
    }
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
            data: data,
            // Показываем только количество, нули затемнены
            label: { 
                show: true, 
                formatter: function(params) {
                    var v = params.value;
                    return Array.isArray(v) ? v[2] : (v && v[2] !== undefined ? v[2] : '');
                },
                fontSize: 14,
                fontWeight: 'bold'
            },
            emphasis: { itemStyle: { borderColor: '#333', borderWidth: 2 } }
        }]
    };
    chart.setOption(option);
    chart.on('click', function(params) {
        var it = matrixData[params.dataIndex];
        if (it) filterRiskTable(frm, it.probability, it.impact);
    });
    frm._risk_matrix_chart = chart;
    
    // Responsive resize handler
    var resizeHandler = function() {
        if (frm._risk_matrix_chart) {
            frm._risk_matrix_chart.resize();
        }
    };
    // Удаляем предыдущий обработчик, если есть
    if (frm._risk_matrix_resize_handler) {
        window.removeEventListener('resize', frm._risk_matrix_resize_handler);
    }
    frm._risk_matrix_resize_handler = resizeHandler;
    window.addEventListener('resize', resizeHandler);
}

async function renderRiskMatrixWrapper(frm) {
    var field = frm.fields_dict['custom_risk_matrix'];
    if (!field || !field.$wrapper || !field.$wrapper.length) return;
    try {
        await loadEcharts();
        var dims = await loadRiskDimensions();
        if (!dims.impacts.length || !dims.probabilities.length) {
            field.$wrapper.find('.risk-matrix-chart-container').remove();
            field.$wrapper.append('<p class="text-muted">' + __('Нет настроенных уровней влияния или вероятности') + '</p>');
            return;
        }
        var matrixData = buildMatrixData(frm, dims.impacts, dims.probabilities, dims.levels);
        renderRiskMatrix(frm, matrixData, dims.impacts, dims.probabilities);
        addClearFilterButton(frm);
    } catch (e) {
        console.error('Project Risk Matrix error:', e);
        field.$wrapper.find('.risk-matrix-chart-container').remove();
        field.$wrapper.append('<p class="text-danger">' + __('Ошибка загрузки матрицы рисков') + ': ' + (e.message || e) + '</p>');
    }
}

function scheduleRiskMatrixRender(frm) {
    if (!frm.doc.name || frm.is_new()) return;
    var field = frm.fields_dict['custom_risk_matrix'];
    if (!field || !field.$wrapper || !field.$wrapper.length) return;
    var $container = field.$wrapper.find('.risk-matrix-chart-container');
    var containerVisible = $container.length && $container.is(':visible') && $container.width() > 0 && $container.height() > 0;
    if (containerVisible && frm._risk_matrix_chart) {
        frm._risk_matrix_chart.resize();
        return;
    }
    renderRiskMatrixWrapper(frm).then(function() {
        if (frm._risk_matrix_chart && !containerVisible) {
            setTimeout(function() {
                if (frm._risk_matrix_chart) frm._risk_matrix_chart.resize();
            }, 100);
        }
    });
}

function bindRiskTabListenerOnce(frm) {
    if (frm._risk_tab_listener_bound) return;
    var $wrapper = frm.$wrapper || (frm.wrapper && $(frm.wrapper));
    if (!$wrapper || !$wrapper.length) return;
    $wrapper.on('shown.bs.tab', '[data-fieldname="custom_риски"]', function() {
        if (frm._risk_matrix_chart) {
            setTimeout(function() {
                if (frm._risk_matrix_chart) frm._risk_matrix_chart.resize();
            }, 50);
        } else {
            scheduleRiskMatrixRender(frm);
        }
    });
    frm._risk_tab_listener_bound = true;
}

frappe.ui.form.on('Project', {
    refresh: function(frm) {
        if (frm.doc.name && !frm.is_new()) {
            scheduleRiskMatrixRender(frm);
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