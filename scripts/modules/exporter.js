/**
 * @fileoverview Multi-Format Export Pipeline
 *
 * Handles exporting scraped product data in three formats:
 * - **Excel** (.xlsx): Multi-sheet workbook with styled headers, analytics,
 *   price/rating distributions, top opportunities, and actionable insights
 * - **CSV**: Lightweight comma-separated export for spreadsheet tools
 * - **JSON**: Full data dump with optional analytics for programmatic use
 *
 * Uses XLSX.js (SheetJS) for Excel generation and the Chrome Downloads API
 * for triggering save-as dialogs.
 *
 * @module Exporter
 * @requires XLSX - SheetJS library (loaded from libs/xlsx.full.min.js)
 * @requires Analyzer - For analytics data in JSON and Excel exports
 */

const Exporter = {
    /**
     * Generate a sanitized filename based on the seller name and current date.
     *
     * @param {Object[]} results - Scraped product results (uses first item's sellerName)
     * @param {string} [format='xlsx'] - File extension
     * @returns {string} Filename like "amazon_store_scraped_data_2026-04-03.xlsx"
     */
    getFileName(results, format = 'xlsx') {
        const date = new Date().toISOString().split('T')[0];
        let storeName = 'amazon_store';

        if (results && results.length > 0 && results[0].sellerName) {
            storeName = results[0].sellerName;
        }

        const sanitizedName = storeName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return `${sanitizedName}_scraped_data_${date}.${format}`;
    },

    /**
     * Export product data as CSV.
     * Includes proper escaping for fields containing commas or quotes.
     *
     * @param {Object[]} results - Array of product objects
     * @returns {{blob: Blob, filename: string}} CSV blob and suggested filename
     */
    exportToCSV(results) {
        const headers = ['Product Name', 'ASIN', 'Price', 'Rating', 'Review Count', 'URL'];
        const rows = [headers.join(',')];

        results.forEach(item => {
            const row = [
                `"${(item.name || '').replace(/"/g, '""')}"`,
                item.asin || '',
                item.price || '',
                item.rating || '',
                item.reviewCount || '',
                `"${item.url || ''}"`
            ];
            rows.push(row.join(','));
        });

        const csvContent = rows.join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        return {
            blob,
            filename: this.getFileName(results, 'csv')
        };
    },

    /**
     * Export product data as JSON with optional analytics.
     * If the Analyzer module is available, includes a full analysis report.
     *
     * @param {Object[]} results - Array of product objects
     * @param {boolean} [includeAnalytics=true] - Whether to include analytics data
     * @returns {{blob: Blob, filename: string}} JSON blob and suggested filename
     */
    exportToJSON(results, includeAnalytics = true) {
        let exportData = { products: results };

        if (includeAnalytics && typeof Analyzer !== 'undefined') {
            exportData.analytics = Analyzer.generateFullReport(results);
        }

        exportData.exportedAt = new Date().toISOString();
        exportData.totalProducts = results.length;

        const jsonContent = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonContent], { type: 'application/json' });
        return {
            blob,
            filename: this.getFileName(results, 'json')
        };
    },

    /**
     * Create a multi-sheet Excel workbook with full analytics.
     *
     * Sheets generated:
     * 1. **Data** - Product listing with header, summary stats, and styled table
     * 2. **Analytics** - Price/rating distributions and top 10 opportunities
     * 3. **Insights** (conditional) - Prioritized actionable insights
     *
     * @param {Object[]} results - Array of product objects
     * @param {Object|null} [analysisReport=null] - Output from Analyzer.generateFullReport()
     * @returns {Object} XLSX.js workbook object
     */
    createExcelWorkbook(results, analysisReport = null) {
        const wb = XLSX.utils.book_new();

        const dataSheet = this.createDataSheet(results);
        XLSX.utils.book_append_sheet(wb, dataSheet, 'Data');

        const analyticsSheet = this.createAnalyticsSheet(results, analysisReport);
        XLSX.utils.book_append_sheet(wb, analyticsSheet, 'Analytics');

        if (analysisReport && analysisReport.insights) {
            const insightsSheet = this.createInsightsSheet(analysisReport);
            XLSX.utils.book_append_sheet(wb, insightsSheet, 'Insights');
        }

        return wb;
    },

    /**
     * Create the main Data sheet with report header, summary statistics,
     * and the full product table.
     *
     * Layout:
     * - Row 1: Report title (merged across all columns)
     * - Rows 3-6: Report details (left) and summary stats (right)
     * - Row 8: Column headers (Product Name, ASIN, Price, Rating, Review Count)
     * - Rows 9+: Product data rows
     *
     * @param {Object[]} results - Array of product objects
     * @returns {Object} XLSX.js worksheet object
     */
    createDataSheet(results) {
        // Calculate averages
        const validPrices = results
            .map(r => parseFloat(String(r.price).replace(/[^0-9.]/g, '')))
            .filter(p => !isNaN(p) && p > 0);
        const validRatings = results
            .map(r => parseFloat(r.rating))
            .filter(r => !isNaN(r) && r > 0);

        const avgPrice = validPrices.length > 0
            ? (validPrices.reduce((a, b) => a + b, 0) / validPrices.length).toFixed(2)
            : 0;
        const avgRating = validRatings.length > 0
            ? (validRatings.reduce((a, b) => a + b, 0) / validRatings.length).toFixed(2)
            : 0;

        // Build worksheet data
        const wsData = [
            ['Amazon Product Analysis Report', '', '', '', ''],
            [],
            ['Report Details', '', '', 'Summary Statistics', ''],
            ['Generated Date:', new Date().toLocaleDateString(), '', 'Total Products:', results.length],
            ['Time:', new Date().toLocaleTimeString(), '', 'Average Rating:', parseFloat(avgRating)],
            ['Status:', 'Complete', '', 'Average Price:', parseFloat(avgPrice)],
            [],
            ['Product Name', 'ASIN', 'Price ($)', 'Rating', 'Review Count']
        ];

        // Add data rows
        results.forEach(item => {
            const price = parseFloat(String(item.price).replace(/[^0-9.]/g, '')) || 0;
            const rating = parseFloat(item.rating) || 0;
            const reviewCount = parseInt(item.reviewCount) || 0;

            wsData.push([
                item.name || '',
                item.asin || '',
                price,
                rating,
                reviewCount
            ]);
        });

        const ws = XLSX.utils.aoa_to_sheet(wsData);

        // Set column widths
        ws['!cols'] = [
            { wch: 45 }, // Product Name
            { wch: 12 }, // ASIN
            { wch: 10 }, // Price
            { wch: 8 },  // Rating
            { wch: 12 }  // Review Count
        ];

        // Set merged cells for title and section headers
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }, // Title
            { s: { r: 2, c: 0 }, e: { r: 2, c: 2 } }, // Report Details
            { s: { r: 2, c: 3 }, e: { r: 2, c: 4 } }  // Summary Statistics
        ];

        // Apply styles
        this.applyDataSheetStyles(ws, wsData.length);

        return ws;
    },

    /**
     * Create the Analytics sheet with distribution tables and top opportunities.
     *
     * Sections:
     * - Price distribution (5 buckets)
     * - Rating distribution (4 buckets)
     * - Top 10 opportunities with opportunity scores
     *
     * @param {Object[]} results - Array of product objects
     * @param {Object|null} analysisReport - Output from Analyzer.generateFullReport()
     * @returns {Object} XLSX.js worksheet object
     */
    createAnalyticsSheet(results, analysisReport) {
        const priceDistribution = { '$0-$10': 0, '$10-$25': 0, '$25-$50': 0, '$50+': 0 };
        const ratingDistribution = { '5 Stars': 0, '4-4.9 Stars': 0, '3-3.9 Stars': 0, 'Below 3': 0 };

        results.forEach(item => {
            const price = parseFloat(String(item.price).replace(/[^0-9.]/g, '') || '0');
            if (price < 10) priceDistribution['$0-$10']++;
            else if (price < 25) priceDistribution['$10-$25']++;
            else if (price < 50) priceDistribution['$25-$50']++;
            else priceDistribution['$50+']++;

            const rating = parseFloat(item.rating || '0');
            if (rating >= 4.8) ratingDistribution['5 Stars']++;
            else if (rating >= 4) ratingDistribution['4-4.9 Stars']++;
            else if (rating >= 3) ratingDistribution['3-3.9 Stars']++;
            else ratingDistribution['Below 3']++;
        });

        const chartData = [
            ['Price Distribution', ''],
            ['Price Range', 'Count'],
            ...Object.entries(priceDistribution),
            [],
            ['Rating Distribution', ''],
            ['Rating', 'Count'],
            ...Object.entries(ratingDistribution),
            [],
            ['Top Opportunities', '', '', ''],
            ['Product', 'Price', 'Rating', 'Score']
        ];

        // Add top opportunities if available
        if (analysisReport && analysisReport.topOpportunities) {
            analysisReport.topOpportunities.slice(0, 10).forEach(opp => {
                chartData.push([
                    opp.name?.substring(0, 40) || '',
                    opp.price || '',
                    opp.rating || '',
                    opp.opportunityScore?.toFixed(1) || ''
                ]);
            });
        }

        const ws = XLSX.utils.aoa_to_sheet(chartData);

        ws['!cols'] = [
            { wch: 40 },
            { wch: 15 },
            { wch: 15 },
            { wch: 10 }
        ];

        return ws;
    },

    /**
     * Create the Insights sheet with prioritized actionable recommendations.
     *
     * @param {Object} analysisReport - Output from Analyzer.generateFullReport()
     * @returns {Object} XLSX.js worksheet object
     */
    createInsightsSheet(analysisReport) {
        const insightsData = [
            ['Actionable Insights', ''],
            [],
            ['Priority', 'Insight', 'Action']
        ];

        analysisReport.insights.forEach(insight => {
            insightsData.push([
                insight.priority?.toUpperCase() || '',
                insight.title || '',
                insight.action || ''
            ]);
            if (insight.description) {
                insightsData.push(['', insight.description, '']);
            }
            insightsData.push([]); // Empty row for spacing
        });

        const ws = XLSX.utils.aoa_to_sheet(insightsData);

        ws['!cols'] = [
            { wch: 10 },
            { wch: 50 },
            { wch: 50 }
        ];

        return ws;
    },

    /**
     * Apply visual styles to the Data sheet.
     * Styles include: blue title bar, white-on-blue column headers,
     * currency formatting for prices, and number formatting for reviews.
     *
     * @param {Object} ws - XLSX.js worksheet object
     * @param {number} rowCount - Total number of rows in the worksheet
     */
    applyDataSheetStyles(ws, rowCount) {
        const styles = {
            title: {
                font: { bold: true, sz: 16, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "2F75B5" } },
                alignment: { horizontal: "center", vertical: "center" }
            },
            header: {
                font: { bold: true, sz: 11, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "2F75B5" } },
                alignment: { horizontal: "center", vertical: "center" }
            },
            cell: {
                font: { sz: 10 },
                alignment: { horizontal: "left", vertical: "center", wrapText: true }
            }
        };

        // Apply title style
        const titleCell = XLSX.utils.encode_cell({ r: 0, c: 0 });
        if (ws[titleCell]) ws[titleCell].s = styles.title;

        // Apply header styles to row 8 (index 7)
        for (let c = 0; c <= 4; c++) {
            const cellAddr = XLSX.utils.encode_cell({ r: 7, c });
            if (ws[cellAddr]) ws[cellAddr].s = styles.header;
        }

        // Apply number formatting to data rows
        for (let r = 8; r < rowCount; r++) {
            // Price column -- currency format
            const priceCell = XLSX.utils.encode_cell({ r, c: 2 });
            if (ws[priceCell]) ws[priceCell].z = '$0.00';

            // Rating column -- one decimal place
            const ratingCell = XLSX.utils.encode_cell({ r, c: 3 });
            if (ws[ratingCell]) ws[ratingCell].z = '0.0';

            // Review count column -- thousands separator
            const reviewCell = XLSX.utils.encode_cell({ r, c: 4 });
            if (ws[reviewCell]) ws[reviewCell].z = '#,##0';
        }
    },

    /**
     * Generate and package an Excel workbook as a downloadable blob.
     *
     * @param {Object[]} results - Array of product objects
     * @param {Object|null} [analysisReport=null] - Output from Analyzer.generateFullReport()
     * @returns {{blob: Blob, filename: string}} Excel blob and suggested filename
     */
    exportToExcel(results, analysisReport = null) {
        const wb = this.createExcelWorkbook(results, analysisReport);

        const wbout = XLSX.write(wb, {
            bookType: 'xlsx',
            type: 'array',
            bookSST: false,
            compression: true
        });

        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        return {
            blob,
            filename: this.getFileName(results, 'xlsx')
        };
    },

    /**
     * Trigger a file download using the Chrome Downloads API.
     * Opens a save-as dialog and cleans up the object URL after download.
     *
     * @param {Blob} blob - File content as a Blob
     * @param {string} filename - Suggested filename for the download
     * @param {Function} [callback] - Called with downloadId on success, null on failure
     */
    triggerDownload(blob, filename, callback) {
        const url = URL.createObjectURL(blob);

        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        }, (downloadId) => {
            URL.revokeObjectURL(url);
            if (callback) {
                callback(chrome.runtime.lastError ? null : downloadId);
            }
        });
    }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Exporter;
}
