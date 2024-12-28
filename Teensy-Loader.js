/**
 * teensy-library.js
 * 
 * A small JavaScript library for working with multiple Teensy boards via WebHID and Serial.
 * 
 * Classes:
 *  - FirmwareFile: Manages local firmware data (hex or bin).
 *  - TeensyFlasher: Attempts to flash firmware blocks to a Teensy device over WebHID.
 *  - SerialPortManager: Opens/closes a serial port and handles incoming data.
 */

////////////////////////////////////////////////////////////////////////////////
// Utility Functions (internal to this library)
////////////////////////////////////////////////////////////////////////////////

/**
 * Sleep for a specified number of milliseconds.
 * @param {number} ms - milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse an Intel HEX file (provided as a Uint8Array) into fixed-size blocks.
 * @private
 * @param {Uint8Array} hexData - The full `.hex` file data as bytes.
 * @param {number} blockSize - The size of each block in bytes (e.g., 1024).
 * @param {number} offset - The address offset (e.g., 0x60000000 for Teensy 4.x).
 * @returns {Promise<Uint8Array[]>} - An array of `blockSize`-length Uint8Arrays.
 */
async function parseHexToBlocks(hexData, blockSize, offset) {
const text = new TextDecoder().decode(hexData);
const lines = text.split(/\r?\n/);
const blocks = [];
let baseAddress = 0;

/**
 * Ensure the `blocks[idx]` array exists; otherwise create a new block
 * filled with 0xFF.
 */
function ensureBlock(idx) {
    if (!blocks[idx]) {
        const block = new Uint8Array(blockSize);
        block.fill(0xff);
        blocks[idx] = block;
    }
}

for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    let line = lines[lineNum].trim();
    if (!line) continue;
    if (!line.startsWith(':')) {
        throw new Error(`Invalid HEX: missing ':' on line ${lineNum + 1}`);
    }

    line = line.slice(1);
    // Parse length, address, record type, data + checksum
    const length = parseInt(line.slice(0, 2), 16);
    const address = parseInt(line.slice(2, 6), 16);
    const recordType = parseInt(line.slice(6, 8), 16);
    let cursor = 8;
    let calcSum = length + ((address >> 8) & 0xff) + (address & 0xff) + recordType;

    if (line.length !== (10 + length * 2)) {
     throw new Error(`Line length mismatch on line ${lineNum + 1}`);
    }

    switch (recordType) {
        case 0x00: {
            // data record
            const dataBytes = new Uint8Array(length);
            for (let i = 0; i < length; i++) {
            const byteVal = parseInt(line.slice(cursor, cursor + 2), 16);
            cursor += 2;
            dataBytes[i] = byteVal;
            calcSum += byteVal;
            }

            const checkSum = parseInt(line.slice(cursor, cursor + 2), 16);
            calcSum = calcSum & 0xff;
            const total = (calcSum + checkSum) & 0xff;
            if (total !== 0) {
            throw new Error(`Checksum error on line ${lineNum + 1}`);
            }

            let addr32 = baseAddress + address;
            // Subtract offset (e.g. 0x60000000 for Teensy 4.x, or 0x0 for 3.x)
            addr32 -= offset;

            if (addr32 < 0) {
            // data is below offset
            continue;
            }

            // Place bytes into blocks
            let dataIndex = 0;
            while (dataIndex < dataBytes.length) {
            const blockIndex = Math.floor(addr32 / blockSize);
            ensureBlock(blockIndex);

            const blockStartAddr = blockIndex * blockSize;
            const withinBlockOffset = addr32 - blockStartAddr;
            const spaceInBlock = blockSize - withinBlockOffset;
            const toCopy = Math.min(spaceInBlock, dataBytes.length - dataIndex);

            blocks[blockIndex].set(
                dataBytes.subarray(dataIndex, dataIndex + toCopy),
                withinBlockOffset
            );

            dataIndex += toCopy;
            addr32 += toCopy;
            }
            break;
        }
        case 0x01: {
            // End of file record
            for (let i = 0; i < length; i++) {
            const byteVal = parseInt(line.slice(cursor, cursor + 2), 16);
            cursor += 2;
            calcSum += byteVal;
            }
            const checkSum = parseInt(line.slice(cursor, cursor + 2), 16);
            calcSum = calcSum & 0xff;
            const total = (calcSum + checkSum) & 0xff;
            if (total !== 0) {
            throw new Error(`Checksum error on EOF line ${lineNum + 1}`);
            }
            // No more data records, stop here
            break;
        }
        case 0x02: {
            // Extended Segment Address Record
            const highAddr = parseInt(line.slice(cursor, cursor + 4), 16);
            calcSum += ((highAddr >> 8) & 0xff) + (highAddr & 0xff);
            cursor += 4;
            const checkSum = parseInt(line.slice(cursor, cursor + 2), 16);
            calcSum = calcSum & 0xff;
            if (((calcSum + checkSum) & 0xff) !== 0) {
            throw new Error(`Checksum error on line ${lineNum + 1}`);
            }
            baseAddress = highAddr << 4;
            break;
        }
        case 0x04: {
            // Extended Linear Address Record
            const upper16 = parseInt(line.slice(cursor, cursor + 4), 16);
            calcSum += ((upper16 >> 8) & 0xff) + (upper16 & 0xff);
            cursor += 4;
            const checkSum = parseInt(line.slice(cursor, cursor + 2), 16);
            calcSum = calcSum & 0xff;
            if (((calcSum + checkSum) & 0xff) !== 0) {
            throw new Error(`Checksum error on line ${lineNum + 1}`);
            }
            baseAddress = upper16 << 16;
            break;
        }
        default: {
            // Ignoring other record types (just parse for checksum correctness)
            for (let i = 0; i < length; i++) {
            const byteVal = parseInt(line.slice(cursor, cursor + 2), 16);
            cursor += 2;
            calcSum += byteVal;
            }
            const checkSum = parseInt(line.slice(cursor, cursor + 2), 16);
            calcSum = calcSum & 0xff;
            if (((calcSum + checkSum) & 0xff) !== 0) {
            throw new Error(`Checksum error on line ${lineNum + 1}`);
            }
            break;
        }
    }
}

return blocks.filter(b => b);
}

/**
 * Sends a HID report to a Teensy device, with retries.
 * @private
 * @param {HIDDevice} device - The HID device
 * @param {Uint8Array} data - Data buffer to send
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<boolean>} - True if sent successfully, false otherwise
 */
async function sendReportWithRetries(device, data, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
        await device.sendReport(0, data);
        return true;
        } catch (err) {
        console.warn(`sendReport attempt ${attempt + 1} failed:`, err);
        await sleep(100);
        }
    }
    return false;
}

////////////////////////////////////////////////////////////////////////////////
// Device Info & Offsets
////////////////////////////////////////////////////////////////////////////////

/**
 * Returns a recommended flash offset for each Teensy productId.
 * 
 * - Teensy 4.x boards typically use 0x60000000.
 * - Teensy 3.x boards typically use 0x00000000.
 * @private
 * @param {number} productId 
 * @returns {number} The offset to subtract in the HEX parse
 */
function getAddressOffset(productId) {
    // Common product IDs for older Teensy:
    // Teensy 3.0:  0x0483 (some versions may differ)
    // Teensy 3.1:  0x0484
    // Teensy 3.2:  same as 3.1
    // Teensy 3.5:  0x0474
    // Teensy 3.6:  0x0477
    // Teensy 4.0:  0x0478
    // Teensy 4.1:  0x0479

    // The official vendorId is typically 0x16C0 (5824) for PJRC (Teensy).

    // If you know the exact product ID is for a Teensy 4.x, return 0x60000000.
    // Otherwise default to 0x00000000 for 3.x or unknown boards.

    switch (productId) {
        case 0x0478: // 4.0
        case 0x0479: // 4.1
        return 0x60000000;
        default:
        return 0x00000000;
    }
}

////////////////////////////////////////////////////////////////////////////////
// FirmwareFile: stores local firmware data and generates 1KB blocks
////////////////////////////////////////////////////////////////////////////////

/**
 * Represents a local firmware file (Intel HEX or raw binary) for Teensy.
 */
export class FirmwareFile {
    /**
     * Creates a new FirmwareFile instance.
     * @param {Uint8Array} fileData - Raw file data in bytes
     * @param {string} filename - The original filename (used for extension checks)
     */
    constructor(fileData, filename) {
        this.fileData = fileData;
        this.filename = filename.toLowerCase();
    }

    /**
     * Builds 1KB firmware blocks (Uint8Array[]).
     * If the file has a `.hex` extension, parse as Intel HEX.
     * Otherwise, treat as a raw binary.
     * 
     * @param {number} [offset=0x60000000] - Address offset for HEX parsing.
     *   If you want to handle older Teensy 3.x, you might pass 0x00000000.
     * @returns {Promise<Uint8Array[]>}
     */
    async buildBlocks(offset = 0x60000000) {
        const PAGE_SIZE = 1024;
        if (this.filename.endsWith('.hex')) {
        // parse Intel HEX => 1KB blocks
        return parseHexToBlocks(this.fileData, PAGE_SIZE, offset);
        } else {
        // treat the firmwareFile as a raw .bin, split into 1KB pages
        const pages = [];
        for (let i = 0; i < this.fileData.length; i += PAGE_SIZE) {
            const chunk = this.fileData.slice(i, i + PAGE_SIZE);
            if (chunk.length < PAGE_SIZE) {
            // pad to 1KB with 0xFF
            const padded = new Uint8Array(PAGE_SIZE);
            padded.fill(0xff);
            padded.set(chunk, 0);
            pages.push(padded);
            } else {
            pages.push(chunk);
            }
        }
            return pages;
        }
    }
}

////////////////////////////////////////////////////////////////////////////////
// TeensyFlasher: uses WebHID to flash firmware blocks
////////////////////////////////////////////////////////////////////////////////

/**
 * A helper class to flash a Teensy with firmware data via WebHID.
 * 
 * Note: For Teensy 3.x boards, the native HalfKay bootloader typically
 * does NOT provide a standard HID interface (like Teensy 4.x).
 * Therefore, actual flashing may not work unless the device supports
 * a similar protocol. 
 */
export class TeensyFlasher {
    /**
     * Flashes an array of 1KB firmware pages to the Teensy device.
     * 
     * @param {Uint8Array[]} firmwarePages - An array of 1KB firmware pages
     * @param {HIDDevice} device - The selected Teensy WebHID device
     * @param {(progress: number) => void} [progressCb] - Optional callback for progress (range 0..1)
     * @returns {Promise<void>} - Resolves when flashing is complete
     */
    async flashFirmware(firmwarePages, device, progressCb) {
        if (!progressCb) {
        progressCb = () => {};
        }

        const PAGE_SIZE = 1024;
        const REPORT_SIZE = PAGE_SIZE + 64; // 1088 bytes
        const report = new Uint8Array(REPORT_SIZE);

        // Attempt to open device. For Teensy 4.x, this usually works.
        // For Teensy 3.x, this might fail or not function for flashing.
        await device.open();

        try {
        // Count how many blocks we actually need to send (skip blank blocks except the first).
        const neededBlocks = firmwarePages.filter((b, i) => {
            // We always upload block #0, even if it's blank
            return i === 0 || !b.every(x => x === 0xff);
        }).length;

        let processed = 0;
        for (let i = 0; i < firmwarePages.length; i++) {
            const block = firmwarePages[i];
            // skip blank blocks except for the first
            if (i !== 0 && block.every(x => x === 0xff)) {
            continue;
            }

            // Build HID report
            report.fill(0);
            const addr = i * PAGE_SIZE;
            // address in first 3 bytes
            report[0] = addr & 0xff;
            report[1] = (addr >> 8) & 0xff;
            report[2] = (addr >> 16) & 0xff;
            // copy data at offset 64
            report.set(block, 64);

            // Attempt to send
            const success = await sendReportWithRetries(device, report, 5);
            if (!success) {
            throw new Error(`Block upload failed at block index=${i}`);
            }

            processed++;
            progressCb(processed / neededBlocks);

            // Delay:
            // 1.5s after first block (erase), 5ms for subsequent
            await sleep(i === 0 ? 1500 : 5);
        }

        // Final "magic" = 0xFF, 0xFF, 0xFF
        report.fill(0);
        report[0] = 0xff;
        report[1] = 0xff;
        report[2] = 0xff;
        await sendReportWithRetries(device, report, 5);

        // Optional short wait
        await sleep(100);
        } finally {
        // Always close device
        await device.close().catch(() => {});
        }
    }
}

////////////////////////////////////////////////////////////////////////////////
// SerialPortManager: Opens/closes a serial port and receives data lines
////////////////////////////////////////////////////////////////////////////////

/**
 * Manages a single serial port connection. 
 * Reads lines of text from the port and passes them to an onData callback.
 */
export class SerialPortManager {
    constructor() {
        /**
         * @type {SerialPort | null}
         */
        this.serialPort = null;

        /**
         * @type {ReadableStreamDefaultReader<string> | null}
         */
        this.serialReader = null;

        /**
         * @type {string}
         */
        this.incompleteLine = '';

        /**
         * Callback for incoming text lines. 
         * @type {(line: string) => void | null}
         */
        this.onData = null;
    }

    /**
     * Opens a serial port using the browser's Serial API.
     * @param {SerialOptions} [serialOptions] - e.g. { baudRate: 115200 }
     * @returns {Promise<void>}
     */
    async openSerialPort(serialOptions = { baudRate: 115200 }) {
        if (this.serialPort) {
        throw new Error('Serial port is already open.');
        }
        // Request a serial port from the user
        this.serialPort = await navigator.serial.requestPort();
        // Open with given baud rate, etc.
        await this.serialPort.open(serialOptions);

        // Create a text decoder to read the stream as text
        const textDecoder = new TextDecoderStream();
        const readableStreamClosed = this.serialPort.readable.pipeTo(textDecoder.writable);
        this.serialReader = textDecoder.readable.getReader();

        // Continuously read from the port in a background async function
        (async () => {
        try {
            while (true) {
            const { value, done } = await this.serialReader.read();
            if (done) break; // reader cancelled
            this.processSerialData(value);
            }
        } catch (err) {
            console.error('Serial reading error:', err);
        }
        })();
    }

    /**
     * Handles incoming raw data from the serial port, splitting on newline.
     * @private
     * @param {string} dataChunk - The raw text data chunk
     */
    processSerialData(dataChunk) {
        this.incompleteLine += dataChunk;
        const lines = this.incompleteLine.split('\n');

        // For all complete lines, pass them to onData
        for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (this.onData) {
            this.onData(line);
        }
        }

        // Save the last partial line
        this.incompleteLine = lines[lines.length - 1];
    }

    /**
     * Closes the serial port connection.
     * @returns {Promise<void>}
     */
    async closeSerialPort() {
        if (!this.serialPort) {
        throw new Error('No serial port is open.');
        }
        // Cancel the reader
        if (this.serialReader) {
        await this.serialReader.cancel();
        this.serialReader = null;
        }
        // Close the port
        await this.serialPort.close();
        this.serialPort = null;
        this.incompleteLine = '';
    }
}

/**
 * Example device filters to include multiple Teensy boards (3.x and 4.x).
 * You can use these in your own `navigator.hid.requestDevice(...)`.
 */
export const TEENSY_DEVICE_FILTERS = [
    // Common vendorId for PJRC Teensy
    { vendorId: 0x16c0, productId: 0x0478 }, // Teensy 4.0
    { vendorId: 0x16c0, productId: 0x0479 }, // Teensy 4.1
    { vendorId: 0x16c0, productId: 0x0477 }, // Teensy 3.6 - untested
    { vendorId: 0x16c0, productId: 0x0474 }, // Teensy 3.5 - untested
    { vendorId: 0x16c0, productId: 0x0483 }, // Possibly Teensy 3.0 - untested
    { vendorId: 0x16c0, productId: 0x0484 }, // Possibly Teensy 3.1 / 3.2 - untested
];
