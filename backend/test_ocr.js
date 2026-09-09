const Tesseract = require('tesseract.js');
const path = require('path');
const fs = require('fs');

async function testOCR(imagePath) {
    if (!imagePath) {
        console.error("Please provide an image path. Usage: node test_ocr.js <path-to-image>");
        process.exit(1);
    }

    const absolutePath = path.resolve(imagePath);
    if (!fs.existsSync(absolutePath)) {
        console.error(`File not found: ${absolutePath}`);
        process.exit(1);
    }

    console.log(`Starting OCR on: ${absolutePath}`);
    console.log("Loading tesseract core and language data (eng+hin)...");
    
    try {
        const worker = await Tesseract.createWorker(['eng', 'hin']);
        
        console.log("Recognizing text (this might take a few seconds)...");
        const { data: { text, words } } = await worker.recognize(absolutePath);
        
        console.log("\n================ EXTRACTED TEXT ================\n");
        console.log(text);
        console.log("\n================================================\n");
        
        // Find low confidence words to simulate "uncertain_spans"
        const uncertainWords = words.filter(w => w.confidence < 60).map(w => w.text);
        console.log(`Total words: ${words.length}`);
        console.log(`Low confidence words (< 60%): ${uncertainWords.length}`);
        if (uncertainWords.length > 0) {
            console.log("Sample uncertain words: ", uncertainWords.slice(0, 10).join(', '));
        }

        await worker.terminate();
        console.log("\nOCR complete. Please review the output above.");
    } catch (error) {
        console.error("OCR Failed:", error);
    }
}

const args = process.argv.slice(2);
testOCR(args[0]);
