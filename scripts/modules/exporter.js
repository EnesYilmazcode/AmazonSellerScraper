// exporter.js - Export functionality for scraped data
// Supports Excel, CSV, and JSON exports

const Exporter = {
    // Generate filename based on results and date
    getFileName(results, format = 'xlsx') {
        const date = new Date().toISOString().split('T')[0];
        let storeName = 'amazon_store';

        if (results && results.length > 0 && results[0].sellerName) {
            storeName = results[0].sellerName;
        }

        const sanitizedName = storeName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return `${sanitizedName}_scraped_data_${date}.${format}`;
    },

    // Export to CSV
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

    // Export to JSON
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

    // Create Excel workbook with styling
    createExcelWorkbook(results, analysisReport = null) {
        const wb = XLSX.utils.book_new();

        // Create Data Sheet
        const dataSheet = this.createDataSheet(results);
        XLSX.utils.book_append_sheet(wb, dataSheet, 'Data');

        // Create Analytics Sheet
        const analyticsSheet = this.createAnalyticsSheet(results, analysisReport);
        XLSX.utils.book_append_sheet(wb, analyticsSheet, 'Analytics');

        // Create Insights Sheet if we have analysis
        if (analysisReport && analysisReport.insights) {
            const insightsSheet = this.createInsightsSheet(analysisReport);
            XLSX.utils.book_append_sheet(wb, insightsSheet, 'Insights');
        }

        return wb;
    },

    // Create main data sheet
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

        // Set merged cells
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }, // Title
            { s: { r: 2, c: 0 }, e: { r: 2, c: 2 } }, // Report Details
            { s: { r: 2, c: 3 }, e: { r: 2, c: 4 } }  // Summary Statistics
        ];

        // Apply styles
        this.applyDataSheetStyles(ws, wsData.length);

        return ws;
    },

    // Create analytics sheet
    createAnalyticsSheet(results, analysisReport) {
        // Calculate distributions
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

    // Create insights sheet
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

    // Apply styles to data sheet
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

        // Apply number formatting
        for (let r = 8; r < rowCount; r++) {
            // Price column
            const priceCell = XLSX.utils.encode_cell({ r, c: 2 });
            if (ws[priceCell]) ws[priceCell].z = '$0.00';

            // Rating column
            const ratingCell = XLSX.utils.encode_cell({ r, c: 3 });
            if (ws[ratingCell]) ws[ratingCell].z = '0.0';

            // Review count column
            const reviewCell = XLSX.utils.encode_cell({ r, c: 4 });
            if (ws[reviewCell]) ws[reviewCell].z = '#,##0';
        }
    },

    // Export to Excel
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

    // Trigger download using Chrome Downloads API
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
