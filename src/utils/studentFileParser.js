import * as xlsx from 'xlsx';
import { PDFParse } from 'pdf-parse';

/**
 * Regex for identifying USN patterns:
 * Handles VTU format (e.g., 2VD23CS001, 2VD21CS099, 2VD24AIM005)
 * and general alphanumeric USN formats (8-12 alphanumeric characters).
 */
const VTU_USN_REGEX = /\b([0-9][A-Z]{2}[0-9]{2}[A-Z]{2,3}[0-9]{3})\b/i;
const GENERAL_USN_REGEX = /\b([0-9A-Z]{8,12})\b/i;

/**
 * Parses an uploaded student list file (Excel, CSV, or PDF) and extracts [ { usn, name } ].
 * 
 * @param {Buffer} buffer - File buffer from multer memoryStorage
 * @param {string} originalname - Original file name (e.g. 'students.xlsx')
 * @param {string} [mimetype] - Optional MIME type
 * @returns {Promise<{ students: Array<{ usn: string, name: string }>, totalExtracted: number }>}
 */
export async function parseStudentFile(buffer, originalname = '', mimetype = '') {
  const filename = String(originalname).toLowerCase();

  if (
    filename.endsWith('.xlsx') ||
    filename.endsWith('.xls') ||
    filename.endsWith('.csv') ||
    mimetype.includes('spreadsheet') ||
    mimetype.includes('excel') ||
    mimetype.includes('csv') ||
    mimetype.includes('text/plain')
  ) {
    return parseExcelFile(buffer);
  }

  if (filename.endsWith('.pdf') || mimetype.includes('pdf')) {
    return parsePdfFile(buffer);
  }

  throw new Error('Unsupported file format. Please upload an Excel (.xlsx, .xls), CSV (.csv), or PDF (.pdf) file.');
}

/**
 * Parses Excel files (.xlsx / .xls) and CSV files (.csv)
 */
export function parseExcelFile(buffer) {
  let workbook;
  try {
    workbook = xlsx.read(buffer, { type: 'buffer' });
  } catch (err) {
    try {
      const text = buffer.toString('utf8');
      workbook = xlsx.read(text, { type: 'string' });
    } catch (csvErr) {
      throw new Error('Could not parse Excel or CSV file. The file may be corrupt or encrypted.');
    }
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('Excel workbook contains no sheets.');
  }

  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  if (!rows || rows.length === 0) {
    throw new Error('The uploaded Excel sheet is empty.');
  }

  // 1. Attempt to find header row containing USN and Name
  let usnColIndex = -1;
  let nameColIndex = -1;
  let headerRowIndex = -1;

  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;

    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || '').trim().toLowerCase();

      // Check USN column
      if (
        usnColIndex === -1 &&
        (cell === 'usn' || cell === 'usn no' || cell === 'usn number' ||
         cell === 'university seat number' || cell === 'roll no' ||
         cell === 'register number' || cell === 'reg no' || cell.includes('usn'))
      ) {
        usnColIndex = c;
      }

      // Check Name column
      if (
        nameColIndex === -1 &&
        (cell === 'name' || cell === 'student name' || cell === 'candidate name' ||
         cell === 'full name' || cell === 'student_name' || (cell.includes('name') && !cell.includes('father') && !cell.includes('college')))
      ) {
        nameColIndex = c;
      }
    }

    if (usnColIndex !== -1 && nameColIndex !== -1) {
      headerRowIndex = r;
      break;
    }
  }

  const students = [];

  // If header found, extract based on detected column indices
  if (usnColIndex !== -1 && nameColIndex !== -1) {
    for (let r = headerRowIndex + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      const rawUsn = String(row[usnColIndex] || '').trim();
      const rawName = String(row[nameColIndex] || '').trim();

      // Skip completely empty rows
      if (!rawUsn && !rawName) continue;

      const cleanedUsn = cleanUsn(rawUsn);
      const cleanedName = cleanName(rawName);

      if (cleanedUsn && cleanedName) {
        students.push({ usn: cleanedUsn, name: cleanedName });
      } else {
        students.push({
          usn: cleanedUsn || rawUsn,
          name: cleanedName || rawName,
          invalidReason: !cleanedUsn ? 'Invalid or missing USN' : 'Invalid or missing student name'
        });
      }
    }
  } else {
    // Fallback: search row-by-row for any cell matching USN format and another cell with alphabetic name
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      let foundUsn = '';
      let foundName = '';

      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] || '').trim();
        const candidateUsn = cleanUsn(cell);

        if (candidateUsn && !foundUsn) {
          foundUsn = candidateUsn;
        } else if (isProbableName(cell) && !foundName) {
          foundName = cleanName(cell);
        }
      }

      if (foundUsn && foundName) {
        students.push({ usn: foundUsn, name: foundName });
      }
    }
  }

  if (students.length === 0) {
    throw new Error('No valid students found in Excel file. Please ensure the file has USN and Name columns.');
  }

  return { students, totalExtracted: students.length };
}

/**
 * Parses text-based / tabular PDF files
 */
export async function parsePdfFile(buffer) {
  let pdfParser;
  let fullText = '';

  try {
    pdfParser = new PDFParse({ data: buffer });
    const textResult = await pdfParser.getText();
    fullText = textResult?.text || '';
  } catch (err) {
    throw new Error(`Could not read PDF file: ${err.message || 'Unknown PDF error'}`);
  } finally {
    if (pdfParser && typeof pdfParser.destroy === 'function') {
      try {
        await pdfParser.destroy();
      } catch (e) {
        // ignore cleanup error
      }
    }
  }

  // Detect scanned / image-only PDFs
  if (!fullText || fullText.trim().length < 20) {
    throw new Error(
      'The uploaded PDF does not contain selectable text (it appears to be a scanned image). Please upload a text-based PDF or an Excel spreadsheet (.xlsx / .xls). OCR is required for scanned documents.'
    );
  }

  const lines = fullText.split(/\r?\n/);
  const students = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip generic header lines
    if (
      line.toLowerCase().includes('page') ||
      line.toLowerCase().includes('sl no') ||
      line.toLowerCase().includes('university') ||
      line.toLowerCase().includes('department of')
    ) {
      continue;
    }

    // Look for VTU / USN match in the line
    const match = line.match(VTU_USN_REGEX) || line.match(GENERAL_USN_REGEX);

    if (match) {
      const usn = cleanUsn(match[0]);
      
      // Extract the name portion from the line around the USN
      // Line format could be: "1 | 2VD23CS001 | ABHINANDAN S LOHAR" or "1  2VD23CS001  ABHINANDAN S LOHAR"
      let namePart = '';

      if (line.includes('|')) {
        const parts = line.split('|').map(p => p.trim());
        const usnIndex = parts.findIndex(p => p.includes(match[0]));
        if (usnIndex !== -1 && usnIndex + 1 < parts.length) {
          namePart = parts[usnIndex + 1];
        }
      } else {
        // Remove the USN from the line
        let remaining = line.replace(match[0], ' ');
        // Remove leading serial number (e.g. "1.", "1 ", "1 -")
        remaining = remaining.replace(/^\s*\d+\s*[\.\,\)\|\-]?\s*/, ' ');
        // Remove trailing numbers / extra data
        remaining = remaining.replace(/[\d\.\-\/]+$/, ' ');
        namePart = remaining;
      }

      const name = cleanName(namePart);

      if (usn && name && name.length >= 2) {
        students.push({ usn, name });
      }
    }
  }

  if (students.length === 0) {
    throw new Error(
      'No valid student records could be extracted from this PDF. Please verify that the PDF contains readable USN and Name columns, or upload an Excel spreadsheet.'
    );
  }

  return { students, totalExtracted: students.length };
}

/**
 * Validates and normalizes USN
 */
function cleanUsn(str) {
  if (!str) return '';
  const trimmed = String(str).trim().toUpperCase();
  const vtuMatch = trimmed.match(VTU_USN_REGEX);
  if (vtuMatch) return vtuMatch[0];

  const genMatch = trimmed.match(GENERAL_USN_REGEX);
  if (genMatch && /[0-9]/.test(genMatch[0]) && /[A-Z]/i.test(genMatch[0])) {
    return genMatch[0];
  }

  return '';
}

/**
 * Cleans student name
 */
function cleanName(str) {
  if (!str) return '';
  let cleaned = String(str)
    .replace(/[0-9\t\r\n\|]/g, ' ') // remove digits and pipes
    .replace(/[^\w\s\.\,\']/gi, ' ') // keep letters, dots, commas
    .replace(/\s+/g, ' ')
    .trim();

  // If starts with punctuation, strip it
  cleaned = cleaned.replace(/^[\.\,\-\s]+/, '').replace(/[\.\,\-\s]+$/, '');
  return cleaned.toUpperCase();
}

/**
 * Checks if a string looks like a person's name
 */
function isProbableName(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (s.length < 2 || s.length > 80) return false;
  // Must contain letters, no digits
  return /[a-zA-Z]{2,}/.test(s) && !/\d/.test(s);
}