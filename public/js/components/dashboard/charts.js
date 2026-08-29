/**
 * Dashboard Charts Module
 * 职责：使用 Chart.js 渲染配额分布图和使用趋势图
 *
 * 调用时机：
 *   - dashboard 组件 init() 时初始化图表
 *   - 筛选器变化时更新图表数据
 *   - $store.data 更新时刷新图表
 *
 * 图表类型：
 *   1. Quota Distribution（饼图）：按模型家族或具体模型显示配额分布
 *   2. Usage Trend（折线图）：显示历史使用趋势
 *
 * 特殊处理：
 *   - 使用 _trendChartUpdateLock 防止并发更新导致的竞争条件
 *   - 通过 debounce 优化频繁更新的性能
 *   - 响应式处理：移动端自动调整图表大小和标签显示
 *
 * @module DashboardCharts
 */
window.DashboardCharts = window.DashboardCharts || {};

// Helper to get CSS variable values (alias to window.utils.getThemeColor)
const getThemeColor = (name) => window.utils.getThemeColor(name);

// Color palette for different families and models
const FAMILY_COLORS = {
  get claude() {
    return getThemeColor("--color-neon-purple");
  },
  get gemini() {
    return getThemeColor("--color-neon-green");
  },
  get other() {
    return getThemeColor("--color-neon-cyan");
  },
};

const MODEL_COLORS = Array.from({ length: 16 }, (_, i) =>
  getThemeColor(`--color-chart-${i + 1}`)
);

// Export constants for filter module
window.DashboardConstants = { FAMILY_COLORS, MODEL_COLORS };

// Module-level lock to prevent concurrent chart updates (fixes race condition)
let _trendChartUpdateLock = false;

/**
 * Convert hex color to rgba
 * @param {string} hex - Hex color string
 * @param {number} alpha - Alpha value (0-1)
 * @returns {string} rgba color string
 */
window.DashboardCharts.hexToRgba = function (hex, alpha) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return `rgba(${parseInt(result[1], 16)}, ${parseInt(
      result[2],
      16
    )}, ${parseInt(result[3], 16)}, ${alpha})`;
  }
  return hex;
};

/**
 * Check if canvas is ready for Chart creation
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @returns {boolean} True if canvas is ready
 */
function isCanvasReady(canvas) {
  if (!canvas || !canvas.isConnected) return false;
  if (canvas.offsetWidth === 0 || canvas.offsetHeight === 0) return false;

  try {
    const ctx = canvas.getContext("2d");
    return !!ctx;
  } catch (e) {
    return false;
  }
}

/**
 * Create a Chart.js dataset with gradient fill
 * @param {string} label - Dataset label
 * @param {Array} data - Data points
 * @param {string} color - Line color
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @returns {object} Chart.js dataset configuration
 */
window.DashboardCharts.createDataset = function (label, data, color, canvas) {
  let gradient;

  try {
    // Safely create gradient with fallback
    if (canvas && canvas.getContext) {
      const ctx = canvas.getContext("2d");
      if (ctx && ctx.createLinearGradient) {
        gradient = ctx.createLinearGradient(0, 0, 0, 200);
        gradient.addColorStop(0, window.DashboardCharts.hexToRgba(color, 0.12));
        gradient.addColorStop(
          0.6,
          window.DashboardCharts.hexToRgba(color, 0.05)
        );
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      }
    }
  } catch (e) {
    if (window.UILogger) window.UILogger.debug("Gradient fallback:", e.message);
    gradient = null;
  }

  // Fallback to solid color if gradient creation failed
  const backgroundColor =
    gradient || window.DashboardCharts.hexToRgba(color, 0.08);

  return {
    label,
    data,
    borderColor: color,
    backgroundColor: backgroundColor,
    borderWidth: 2.5,
    tension: 0.35,
    fill: true,
    pointRadius: 2.5,
    pointHoverRadius: 6,
    pointBackgroundColor: color,
    pointBorderColor: "rgba(9, 9, 11, 0.8)",
    pointBorderWidth: 1.5,
  };
};

/**
 * Update quota distribution donut chart
 * @param {object} component - Dashboard component instance
 */
window.DashboardCharts.updateCharts = function (component) {
  if (Alpine.store("global")?.activeTab !== "dashboard") return;

  const canvas = document.getElementById("quotaChart");
  if (!canvas || !isCanvasReady(canvas)) return;

  // Use UNFILTERED data for global health chart
  const rows = Alpine.store("data").getUnfilteredQuotaData();
  if (!rows || rows.length === 0) return;

  const healthByFamily = {};
  let totalHealthSum = 0;
  let totalModelCount = 0;

  rows.forEach((row) => {
    const family = row.family || "unknown";
    if (!healthByFamily[family]) {
      healthByFamily[family] = { total: 0, weighted: 0 };
    }

    const quotaInfo = row.quotaInfo || [];
    let avgHealth = 0;
    if (quotaInfo.length > 0) {
      avgHealth = quotaInfo.reduce((sum, q) => sum + (q.pct || 0), 0) / quotaInfo.length;
    }

    healthByFamily[family].total++;
    healthByFamily[family].weighted += avgHealth;
    totalHealthSum += avgHealth;
    totalModelCount++;
  });

  component.stats.overallHealth = totalModelCount > 0
    ? Math.round(totalHealthSum / totalModelCount)
    : 0;

  const familyColors = {
    claude: getThemeColor("--color-neon-purple") || "#a855f7",
    gemini: getThemeColor("--color-neon-green") || "#22c55e",
    unknown: getThemeColor("--color-neon-cyan") || "#06b6d4",
  };

  const data = [];
  const colors = [];
  const labels = [];

  const totalFamilies = Object.keys(healthByFamily).length;
  const segmentSize = 100 / (totalFamilies || 1);

  Object.entries(healthByFamily).forEach(([family, { total, weighted }]) => {
    const health = total > 0 ? weighted / total : 0;
    const activeVal = (health / 100) * segmentSize;
    const inactiveVal = segmentSize - activeVal;

    const familyColor = familyColors[family] || familyColors["unknown"];
    const store = Alpine.store("global");
    const familyKey = "family" + family.charAt(0).toUpperCase() + family.slice(1);
    const familyName = store?.t(familyKey) || family;

    const activeLabel =
      family === "claude" ? store?.t("claudeActive") : family === "gemini" ? store?.t("geminiActive") : `${familyName} ${store?.t("activeSuffix") || ''}`;

    const depletedLabel =
      family === "claude" ? store?.t("claudeEmpty") : family === "gemini" ? store?.t("geminiEmpty") : `${familyName} ${store?.t("depleted") || ''}`;

    data.push(activeVal);
    colors.push(familyColor);
    labels.push(activeLabel);

    data.push(inactiveVal);
    colors.push(window.DashboardCharts.hexToRgba(familyColor, 0.6));
    labels.push(depletedLabel);
  });

  // Fast path: In-place update if chart already exists
  const existing = canvas._chartInstance || component.charts?.quotaDistribution;
  if (existing && !existing.destroyed && existing.canvas === canvas) {
    existing.data.labels = labels;
    existing.data.datasets[0].data = data;
    existing.data.datasets[0].backgroundColor = colors;
    existing.update('none');
    return;
  }

  // Initial creation
  try {
    const newChart = new Chart(canvas, {
       type: "doughnut",
       data: {
         labels: labels,
         datasets: [
           {
             data: data,
             backgroundColor: colors,
             borderColor: getThemeColor("--color-space-950"),
             borderWidth: 0,
             hoverOffset: 0,
             borderRadius: 0,
           },
         ],
       },
       options: {
         responsive: true,
         maintainAspectRatio: false,
         cutout: "85%",
         rotation: -90,
         circumference: 360,
         plugins: {
           legend: { display: false },
           tooltip: { enabled: false },
           title: { display: false },
         },
         animation: false
       },
    });
    
    canvas._chartInstance = newChart;
    component.charts.quotaDistribution = newChart;
  } catch (e) {
    console.error("Failed to create quota chart:", e);
  }
};

/**
 * Update usage trend line chart
 * @param {object} component - Dashboard component instance
 */
window.DashboardCharts.updateTrendChart = function (component) {
  if (Alpine.store("global")?.activeTab !== "dashboard") return;

  if (_trendChartUpdateLock) return;
  _trendChartUpdateLock = true;

  const canvas = document.getElementById("usageTrendChart");
  if (!canvas || !isCanvasReady(canvas)) {
    _trendChartUpdateLock = false;
    return;
  }

  // Use filtered history data based on time range
  const history = window.DashboardFilters.getFilteredHistoryData(component);
  if (!history || Object.keys(history).length === 0) {
    component.hasFilteredTrendData = false;
    _trendChartUpdateLock = false;
    return;
  }

  component.hasFilteredTrendData = true;

  // Sort entries by timestamp for correct order
  const sortedEntries = Object.entries(history).sort(
    ([a], [b]) => new Date(a).getTime() - new Date(b).getTime()
  );

  const timestamps = sortedEntries.map(([iso]) => new Date(iso));
  const isMultiDay = timestamps.length > 1 &&
    timestamps[0].toDateString() !== timestamps[timestamps.length - 1].toDateString();

  const formatLabel = (date) => {
    const timeRange = component.timeRange || '24h';
    if (timeRange === '7d') {
      return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
    } else if (isMultiDay || timeRange === 'all') {
      return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' }) + ' ' +
             date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  };

  const labels = [];
  const datasets = [];

  if (component.displayMode === "family") {
    const dataByFamily = {};
    component.selectedFamilies.forEach((family) => {
      dataByFamily[family] = [];
    });

    sortedEntries.forEach(([iso, hourData]) => {
      const date = new Date(iso);
      labels.push(formatLabel(date));

      component.selectedFamilies.forEach((family) => {
        const familyData = hourData[family];
        const count = familyData?._subtotal || 0;
        dataByFamily[family].push(count);
      });
    });

    component.selectedFamilies.forEach((family) => {
      const color = window.DashboardFilters.getFamilyColor(family);
      const familyKey = "family" + family.charAt(0).toUpperCase() + family.slice(1);
      const label = Alpine.store("global")?.t(familyKey) || family;
      datasets.push(
        window.DashboardCharts.createDataset(label, dataByFamily[family], color, canvas)
      );
    });
  } else {
    const dataByModel = {};
    component.families.forEach((family) => {
      (component.selectedModels[family] || []).forEach((model) => {
        const key = `${family}:${model}`;
        dataByModel[key] = [];
      });
    });

    sortedEntries.forEach(([iso, hourData]) => {
      const date = new Date(iso);
      labels.push(formatLabel(date));

      component.families.forEach((family) => {
        const familyData = hourData[family] || {};
        (component.selectedModels[family] || []).forEach((model) => {
          const key = `${family}:${model}`;
          dataByModel[key].push(familyData[model] || 0);
        });
      });
    });

    component.families.forEach((family) => {
      (component.selectedModels[family] || []).forEach((model, modelIndex) => {
        const key = `${family}:${model}`;
        const color = window.DashboardFilters.getModelColor(family, modelIndex);
        datasets.push(
          window.DashboardCharts.createDataset(model, dataByModel[key], color, canvas)
        );
      });
    });
  }

  const tooltipOptions = {
    backgroundColor: getThemeColor("--color-space-950") || "rgba(10, 10, 11, 0.95)",
    titleColor: getThemeColor("--color-text-main") || "#e8e8ea",
    bodyColor: getThemeColor("--color-text-bright") || "#ffffff",
    footerColor: getThemeColor("--color-neon-cyan") || "#38bdf8",
    borderColor: getThemeColor("--color-space-border") || "rgba(42, 42, 46, 1)",
    borderWidth: 1,
    padding: 10,
    boxPadding: 4,
    cornerRadius: 6,
    displayColors: true,
    usePointStyle: true,
    filter: function (tooltipItem, index, tooltipItems) {
      // Only show datasets with actual requests (> 0). If all are 0, show the first item as "No requests"
      const anyNonZero = tooltipItems.some((item) => (item.parsed?.y || 0) > 0);
      if (anyNonZero) {
        return (tooltipItem.parsed?.y || 0) > 0;
      }
      return index === 0;
    },
    itemSort: function (a, b) {
      // Sort descending so the most used model/family is at the top
      return (b.parsed?.y || 0) - (a.parsed?.y || 0);
    },
    callbacks: {
      label: function (context) {
        const val = context.parsed?.y || 0;
        if (val === 0) {
          return " " + (Alpine.store("global")?.t("noRequests") || "No requests");
        }
        return ` ${context.dataset.label}: ${val.toLocaleString()}`;
      },
      footer: function (tooltipItems) {
        let total = 0;
        tooltipItems.forEach((item) => {
          total += item.parsed?.y || 0;
        });
        if (total > 0 && tooltipItems.length > 1) {
          return `Total: ${total.toLocaleString()}`;
        }
        return "";
      },
    },
  };

  // Fast path: In-place update if chart already exists
  const existing = canvas._chartInstance || component.charts?.usageTrend;
  if (existing && !existing.destroyed && existing.canvas === canvas) {
    existing.data.labels = labels;
    existing.data.datasets = datasets;
    existing.options.plugins.tooltip = tooltipOptions;
    existing.update('none');
    _trendChartUpdateLock = false;
    return;
  }

  try {
    const newChart = new Chart(canvas, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 200 },
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          legend: { display: false },
          tooltip: tooltipOptions,
        },
        scales: {
          x: {
            display: true,
            grid: { display: false },
            ticks: {
              color: getThemeColor("--color-text-muted"),
              font: { size: 10 },
            },
          },
          y: {
            display: true,
            beginAtZero: true,
            grid: {
              display: true,
              color: getThemeColor("--color-space-border") + "1a" || "rgba(255,255,255,0.05)",
            },
            ticks: {
              color: getThemeColor("--color-text-muted"),
              font: { size: 10 },
            },
          },
        },
      },
    });
    
    canvas._chartInstance = newChart;
    component.charts.usageTrend = newChart;
  } catch (e) {
    console.error("Failed to create trend chart:", e);
  } finally {
    _trendChartUpdateLock = false;
  }
};
