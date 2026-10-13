import { addLocalBook } from '../../core/db';
import { detectFormat, extractMetadata, mimeFor } from '../../core/formats';

export interface ImportResult {
  imported: number;
  skipped: string[];
}

export async function importFiles(files: File[]): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: [] };
  for (const file of files) {
    const format = detectFormat(file.name, file.type);
    if (!format) {
      result.skipped.push(file.name);
      continue;
    }
    const meta = await extractMetadata(file, file.name, format);
    await addLocalBook(file, {
      ...meta,
      format,
      fileName: file.name,
      mimeType: mimeFor(file.name, format, file.type),
    });
    result.imported++;
  }
  return result;
}
