/**
 * Builds minimal .docx files in memory, so document tests can use a document
 * of any length without checking large binaries into the repository.
 *
 * A .docx is a zip of three XML parts. The zip here is "stored" (method 0, no
 * compression) — every reader must accept that, and it needs nothing but
 * `zlib.crc32` (Node ≥ 22.2) for the checksums. It is deliberately the
 * smallest valid layout, not a faithful Word export: Boost's converter only
 * needs the content types, the package relationship and `word/document.xml`.
 */
import { writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

interface Entry {
	name: string;
	data: Buffer;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function documentXml(paragraphs: readonly string[]): string {
	const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`);
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}</w:body></w:document>`;
}

/** A stored (uncompressed) zip archive of `entries`. */
export function storedZip(entries: readonly Entry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const nameBytes = Buffer.from(name, "utf8");
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); // local file header signature
		local.writeUInt16LE(20, 4); // version needed: 2.0
		local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
		local.writeUInt16LE(0, 8); // method: stored
		local.writeUInt16LE(0, 10); // mod time
		local.writeUInt16LE(0x21, 12); // mod date: 1980-01-01
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18); // compressed size
		local.writeUInt32LE(data.length, 22); // uncompressed size
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28); // extra length
		locals.push(local, nameBytes, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0); // central directory signature
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0x21, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		// extra, comment, disk number, internal and external attributes: zero
		central.writeUInt32LE(offset, 42); // local header offset
		centrals.push(central, nameBytes);

		offset += local.length + nameBytes.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
	end.writeUInt16LE(entries.length, 8); // entries on this disk
	end.writeUInt16LE(entries.length, 10); // entries in total
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16); // directory offset
	return Buffer.concat([...locals, directory, end]);
}

/** A .docx whose body is one paragraph per entry of `paragraphs`. */
export function docx(paragraphs: readonly string[]): Buffer {
	return storedZip([
		{ name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
		{ name: "_rels/.rels", data: Buffer.from(RELS, "utf8") },
		{ name: "word/document.xml", data: Buffer.from(documentXml(paragraphs), "utf8") },
	]);
}

/**
 * Write a .docx with `lines` numbered paragraphs (`Paragraph 1 …`) to `path`.
 * Each paragraph is padded to roughly `width` characters, so a test can push
 * the converted text past pi's 2000-line or 50 KiB page on purpose.
 */
export function writeLongDocx(path: string, lines: number, width = 40): void {
	const paragraphs = Array.from({ length: lines }, (_, i) => {
		const head = `Paragraph ${i + 1}`;
		return head.length >= width
			? head
			: `${head} ${"lorem ipsum ".repeat(width).slice(0, width - head.length - 1)}`;
	});
	writeFileSync(path, docx(paragraphs));
}
