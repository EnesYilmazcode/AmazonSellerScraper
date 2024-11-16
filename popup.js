let isScrapingActive = false;

function updateItemCount(items) {
    document.getElementById('itemCount').textContent = items;
}

function updateStatus(message) {
    document.getElementById('status').textContent = message;
}

function setScrapingState(isActive) {
    const actionButton = document.getElementById('actionButton');
    const downloadButton = document.getElementById('downloadButton');
    
    isScrapingActive = isActive;
    actionButton.textContent = isActive ? 'Stop Scraping' : 'Start Scraping';
    actionButton.classList.toggle('stop', isActive);
    downloadButton.classList.toggle('hidden', isActive);
}

// Initialize UI
chrome.storage.local.get(['isScrapingActive', 'currentItemCount'], function(data) {
    isScrapingActive = data.isScrapingActive || false;
    updateItemCount(data.currentItemCount || 0);
    setScrapingState(isScrapingActive);
});

document.getElementById('actionButton').addEventListener('click', function() {
    if (!isScrapingActive) {
        // Start scraping
        isScrapingActive = true;
        this.textContent = 'Stop Scraping';
        this.classList.add('stop');
        chrome.storage.local.set({ results: [] }); // Reset results
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.tabs.sendMessage(tabs[0].id, {type: 'START_SCRAPING'});
        });
        updateItemCount(0);
        updateStatus('Scraping in progress...');
        setScrapingState(true);
    } else {
        // Stop scraping
        isScrapingActive = false;
        this.textContent = 'Start Scraping';
        this.classList.remove('stop');
        document.getElementById('downloadButton').classList.remove('hidden');
        showNotification('Scraping stopped. You can download the results now.', 'info');
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            chrome.tabs.sendMessage(tabs[0].id, {type: 'STOP_SCRAPING'});
        });
        updateStatus('Scraping stopped');
        setScrapingState(false);
    }
});

function showNotification(message, type = 'info') {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${type}`; // Will use this for styling
}

function showLoadingSpinner() {
    const downloadButton = document.getElementById('downloadButton');
    downloadButton.innerHTML = `
        <span class="spinner"></span>
        Preparing Download...
    `;
    downloadButton.disabled = true;
}

function resetDownloadButton() {
    const downloadButton = document.getElementById('downloadButton');
    downloadButton.innerHTML = 'Download Results';
    downloadButton.disabled = false;
}

function getFileName(results) {
    const date = new Date().toISOString().split('T')[0];
    let storeName = 'amazon_store';
    
    // Try to get seller name from the first result
    if (results && results.length > 0 && results[0].sellerName) {
        storeName = results[0].sellerName;
    }
    
    const sanitizedSellerName = storeName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `${sanitizedSellerName}_scraped_data_${date}.xlsx`;
}

document.getElementById('downloadButton').addEventListener('click', async function() {
    showLoadingSpinner();
    showNotification('Preparing your Excel file...', 'info');

    try {
        const data = await chrome.storage.local.get(['results']);
        const results = data.results || [];
        
        if (results.length === 0) {
            showNotification('No results to download!', 'error');
            resetDownloadButton();
            return;
        }

        // Create the main data worksheet
        const wb = XLSX.utils.book_new();
        
        // Data Sheet
        const ws_data = [
            ['Amazon Product Analysis Report', '', '', '', ''],
            [],
            ['Report Details', '', '', 'Summary Statistics', ''],
            ['Generated Date:', new Date().toLocaleDateString(), '', 'Total Products:', results.length],
            ['Time:', new Date().toLocaleTimeString(), '', 'Average Rating:', `=ROUND(AVERAGEIF(D9:D${8 + results.length},">0"),2)`],
            ['Status:', 'Complete', '', 'Average Price:', `=ROUND(AVERAGEIF(C9:C${8 + results.length},">0"),2)`],
            [],
            ['Product Name', 'ASIN', 'Price ($)', 'Rating', 'Review Count']
        ];

        // Clean and add data rows
        results.forEach(item => {
            const price = item.price ? parseFloat(item.price.replace(/[^0-9.]/g, '')) : 0;
            const rating = item.rating ? parseFloat(item.rating) : 0;
            const reviewCount = parseInt(item.reviewCount) || 0;
            
            ws_data.push([
                item.name || '',
                item.asin || '',
                price,
                rating,
                reviewCount
            ]);
        });

        // Create main data worksheet
        const ws = XLSX.utils.aoa_to_sheet(ws_data);
        
        // Column Widths
        ws['!cols'] = [
            {wch: 45}, // Product Name
            {wch: 12}, // ASIN
            {wch: 10}, // Price
            {wch: 8},  // Rating
            {wch: 12}  // Review Count
        ];

        // Merged Cells
        ws['!merges'] = [
            {s: {r: 0, c: 0}, e: {r: 0, c: 4}}, // Title
            {s: {r: 2, c: 0}, e: {r: 2, c: 2}}, // Report Details
            {s: {r: 2, c: 3}, e: {r: 2, c: 4}}, // Summary Statistics
        ];

        // Styling functions
        const styles = {
            title: {
                font: { bold: true, sz: 16, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "2F75B5" } },
                alignment: { horizontal: "center", vertical: "center" },
                border: { top: {style: "medium"}, bottom: {style: "medium"}, left: {style: "medium"}, right: {style: "medium"} }
            },
            sectionHeader: {
                font: { bold: true, sz: 12, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "4472C4" } },
                alignment: { horizontal: "left", vertical: "center" },
                border: { top: {style: "thin"}, bottom: {style: "thin"}, left: {style: "thin"}, right: {style: "thin"} }
            },
            header: {
                font: { bold: true, sz: 11, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "2F75B5" } },
                alignment: { horizontal: "center", vertical: "center" },
                border: { top: {style: "thin"}, bottom: {style: "thin"}, left: {style: "thin"}, right: {style: "thin"} }
            },
            cell: {
                font: { sz: 10 },
                alignment: { horizontal: "left", vertical: "center", wrapText: true },
                border: { top: {style: "thin"}, bottom: {style: "thin"}, left: {style: "thin"}, right: {style: "thin"} }
            },
            numeric: {
                font: { sz: 10 },
                alignment: { horizontal: "center", vertical: "center" },
                border: { top: {style: "thin"}, bottom: {style: "thin"}, left: {style: "thin"}, right: {style: "thin"} }
            }
        };

        // Apply styles to specific ranges
        const applyStyle = (ws, range, style) => {
            for (let R = range.s.r; R <= range.e.r; ++R) {
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cell_address = XLSX.utils.encode_cell({r: R, c: C});
                    if (!ws[cell_address]) ws[cell_address] = { v: '' };
                    ws[cell_address].s = style;
                }
            }
        };

        // Apply styles to different sections
        applyStyle(ws, {s:{r:0,c:0},e:{r:0,c:4}}, styles.title); // Title
        applyStyle(ws, {s:{r:2,c:0},e:{r:2,c:4}}, styles.sectionHeader); // Section headers
        applyStyle(ws, {s:{r:7,c:0},e:{r:7,c:4}}, styles.header); // Column headers

        // Apply alternating row colors and proper alignment to data
        for (let R = 8; R < ws_data.length; ++R) {
            for (let C = 0; C <= 4; ++C) {
                const cell_address = XLSX.utils.encode_cell({r: R, c: C});
                if (!ws[cell_address]) ws[cell_address] = { v: '' };
                
                const baseStyle = C >= 2 && C <= 3 ? styles.numeric : styles.cell;
                ws[cell_address].s = {
                    ...baseStyle,
                    fill: { fgColor: { rgb: R % 2 ? "F2F2F2" : "FFFFFF" } }
                };
            }
        }

        // Add conditional formatting for ratings
        const ratingCol = 3; // Column D
        for (let R = 8; R < ws_data.length; ++R) {
            const cell_address = XLSX.utils.encode_cell({r: R, c: ratingCol});
            if (ws[cell_address] && ws[cell_address].v) {
                const rating = parseFloat(ws[cell_address].v);
                let color = "FFFFFF";
                if (rating >= 4.5) color = "C6EFCE"; // Green for high ratings
                else if (rating >= 4.0) color = "FFEB9C"; // Yellow for medium ratings
                else color = "FFC7CE"; // Red for low ratings
                
                ws[cell_address].s = {
                    ...styles.numeric,
                    fill: { fgColor: { rgb: color } }
                };
            }
        }

        // Add number formatting for specific columns
        const applyNumberFormat = (ws, col, startRow, endRow, format) => {
            for (let row = startRow; row <= endRow; row++) {
                const cell_address = XLSX.utils.encode_cell({r: row, c: col});
                if (!ws[cell_address]) continue;
                ws[cell_address].z = format;
                if (typeof ws[cell_address].v === 'string') {
                    ws[cell_address].v = parseInt(ws[cell_address].v) || 0;
                }
            }
        };

        // Apply number formatting to columns
        const dataStartRow = 8;
        const dataEndRow = ws_data.length - 1;

        // Price column (2)
        applyNumberFormat(ws, 2, dataStartRow, dataEndRow, '$0.00');
        // Rating column (3)
        applyNumberFormat(ws, 3, dataStartRow, dataEndRow, '0.0');
        // Review count column (4)
        applyNumberFormat(ws, 4, dataStartRow, dataEndRow, '#,##0');

        // Apply number formatting to summary statistics
        const ratingCell = XLSX.utils.encode_cell({r: 4, c: 4}); // Average Rating cell
        const priceCell = XLSX.utils.encode_cell({r: 5, c: 4}); // Average Price cell
        ws[ratingCell].z = '0.00';
        ws[priceCell].z = '$0.00';

        // Calculate averages directly in JavaScript for the summary section
        const calculateAverage = (arr, key, transform = v => v) => {
            const validValues = arr
                .map(item => transform(item[key]))
                .filter(val => !isNaN(val) && val > 0);
            
            if (validValues.length === 0) return 0;
            
            const sum = validValues.reduce((a, b) => a + b, 0);
            return (sum / validValues.length).toFixed(2);
        };

        // Transform functions for different data types
        const priceTransform = price => parseFloat(price.replace(/[^0-9.]/g, ''));
        const ratingTransform = rating => parseFloat(rating);

        // Calculate averages
        const avgRating = calculateAverage(results, 'rating', ratingTransform);
        const avgPrice = calculateAverage(results, 'price', priceTransform);

        // Update summary statistics cells with calculated values
        ws[ratingCell].v = parseFloat(avgRating);
        ws[priceCell].v = parseFloat(avgPrice);

        // Create Charts Sheet with proper array format
        const chartData = [
            ['Price Distribution', ''],
            ['Price Range', 'Count'],
            ['$0-$10', 0],  // We'll calculate these values in JavaScript
            ['$10-$25', 0],
            ['$25-$50', 0],
            ['$50+', 0],
            [],
            ['Rating Distribution', ''],
            ['Rating', 'Count'],
            ['5 Stars', 0],
            ['4-4.9 Stars', 0],
            ['3-3.9 Stars', 0],
            ['Below 3', 0],
            [],
            ['Category Analysis', '', '', ''],
            ['Category', 'Average Price', 'Average Rating', 'Count']
        ];

        // Calculate price distribution
        results.forEach(item => {
            const price = parseFloat(item.price?.replace(/[^0-9.]/g, '') || '0');
            if (price < 10) chartData[2][1]++;
            else if (price < 25) chartData[3][1]++;
            else if (price < 50) chartData[4][1]++;
            else chartData[5][1]++;
        });

        // Calculate rating distribution
        results.forEach(item => {
            const rating = parseFloat(item.rating || '0');
            if (rating >= 4.8) chartData[9][1]++;
            else if (rating >= 4) chartData[10][1]++;
            else if (rating >= 3) chartData[11][1]++;
            else chartData[12][1]++;
        });

        // Calculate category analysis
        const categories = {};
        results.forEach(item => {
            const category = item.category || 'Uncategorized';
            if (!categories[category]) {
                categories[category] = {
                    count: 0,
                    totalPrice: 0,
                    totalRating: 0
                };
            }
            
            const price = parseFloat(item.price?.replace(/[^0-9.]/g, '') || '0');
            const rating = parseFloat(item.rating || '0');
            
            categories[category].count++;
            categories[category].totalPrice += price;
            categories[category].totalRating += rating;
        });

        // Add category data to chartData
        Object.entries(categories).forEach(([category, data]) => {
            chartData.push([
                category,
                (data.totalPrice / data.count).toFixed(2),
                (data.totalRating / data.count).toFixed(2),
                data.count
            ]);
        });

        const ws_charts = XLSX.utils.aoa_to_sheet(chartData);
        
        // Style the charts sheet
        ws_charts['!cols'] = [
            {wch: 30}, // A
            {wch: 15}, // B
            {wch: 15}, // C
            {wch: 15}  // D
        ];

        // Apply styles to the Analytics sheet
        const chartStyles = {
            header: {
                font: { bold: true, sz: 14, color: { rgb: "FFFFFF" } },
                fill: { fgColor: { rgb: "2F75B5" } },
                alignment: { horizontal: "center" }
            },
            subheader: {
                font: { bold: true, sz: 11 },
                fill: { fgColor: { rgb: "DCE6F1" } }
            },
            data: {
                font: { sz: 10 },
                alignment: { horizontal: "right" }
            }
        };

        // Apply styles to Analytics sheet
        [0, 7, 14].forEach(row => {
            const cell = XLSX.utils.encode_cell({r: row, c: 0});
            ws_charts[cell].s = chartStyles.header;
        });

        // Add both sheets to workbook
        XLSX.utils.book_append_sheet(wb, ws, 'Data');
        XLSX.utils.book_append_sheet(wb, ws_charts, 'Analytics');

        // Generate and download file
        const wbout = XLSX.write(wb, { 
            bookType: 'xlsx', 
            type: 'array',
            bookSST: false,
            compression: true
        });

        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const fileName = getFileName(results); // Pass the results array instead

        chrome.downloads.download({
            url: url,
            filename: fileName,
            saveAs: true
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error('Download error:', chrome.runtime.lastError);
                showNotification('Error downloading file. Please try again.', 'error');
            } else {
                showNotification('Download started successfully!', 'success');
            }
            URL.revokeObjectURL(url);
        });

    } catch (error) {
        console.error('Download error:', error);
        showNotification('Error preparing file. Please try again.', 'error');
    } finally {
        resetDownloadButton();
    }
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === 'UPDATE_PROGRESS') {
        updateItemCount(request.itemCount);
        updateStatus('Scraping in progress...');
    } else if (request.type === 'SCRAPING_COMPLETE') {
        updateItemCount(request.itemCount);
        updateStatus('Scraping complete!');
        setScrapingState(false);
    }
});