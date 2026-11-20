"use strict";

(() => {
  const ZIP32_MAX = 0xffffffff;
  const UTF8_FLAG = 0x0800;
  const CRC_CHUNK_SIZE = 1024 * 1024;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const crcTable = new Uint32Array(256);

  for (let index = 0; index < crcTable.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[index] = value >>> 0;
  }

  function validName(name) {
    return typeof name === "string"
      && name.length > 0
      && !name.startsWith("/")
      && !name.includes("\\")
      && !/[\u0000-\u001f]/.test(name)
      && name.split("/").every((part) => part && part !== "." && part !== "..");
  }

  function updateCrc(crc, bytes) {
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return crc >>> 0;
  }

  async function crc32(blob) {
    let crc = 0xffffffff;
    for (let offset = 0; offset < blob.size; offset += CRC_CHUNK_SIZE) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CRC_CHUNK_SIZE).arrayBuffer());
      crc = updateCrc(crc, bytes);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosTimestamp(date) {
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function localHeader(nameBytes, blob, checksum, timestamp) {
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, UTF8_FLAG, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, timestamp.time, true);
    view.setUint16(12, timestamp.date, true);
    view.setUint32(14, checksum, true);
    view.setUint32(18, blob.size, true);
    view.setUint32(22, blob.size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    return header;
  }

  function centralHeader(nameBytes, blob, checksum, timestamp, offset) {
    const header = new Uint8Array(46);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, UTF8_FLAG, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, timestamp.time, true);
    view.setUint16(14, timestamp.date, true);
    view.setUint32(16, checksum, true);
    view.setUint32(20, blob.size, true);
    view.setUint32(24, blob.size, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    return header;
  }

  function endRecord(entryCount, directorySize, directoryOffset) {
    const record = new Uint8Array(22);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, directorySize, true);
    view.setUint32(16, directoryOffset, true);
    view.setUint16(20, 0, true);
    return record;
  }

  async function createZip(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length >= 0xffff) {
      throw new Error("The backup contains an unsupported number of files.");
    }

    const names = new Set();
    const dataParts = [];
    const directoryParts = [];
    const timestamp = dosTimestamp(new Date());
    let offset = 0;

    for (const entry of entries) {
      if (!entry || !validName(entry.name) || !(entry.blob instanceof Blob)) {
        throw new Error("The backup contains an invalid file.");
      }
      if (names.has(entry.name)) throw new Error("The backup contains duplicate file names.");
      names.add(entry.name);

      const nameBytes = encoder.encode(entry.name);
      if (nameBytes.length > 0xffff || entry.blob.size >= ZIP32_MAX) {
        throw new Error("A backup file exceeds the supported ZIP size limit.");
      }
      const checksum = await crc32(entry.blob);
      const nextOffset = offset + 30 + nameBytes.length + entry.blob.size;
      if (nextOffset >= ZIP32_MAX) throw new Error("This backup is too large to package safely.");

      dataParts.push(localHeader(nameBytes, entry.blob, checksum, timestamp), nameBytes, entry.blob);
      directoryParts.push(centralHeader(nameBytes, entry.blob, checksum, timestamp, offset), nameBytes);
      offset = nextOffset;
    }

    const directorySize = directoryParts.reduce((total, part) => total + part.length, 0);
    if (offset + directorySize + 22 >= ZIP32_MAX) {
      throw new Error("This backup is too large to package safely.");
    }
    return new Blob([...dataParts, ...directoryParts, endRecord(entries.length, directorySize, offset)], {
      type: "application/zip"
    });
  }

  async function openZip(file) {
    if (!(file instanceof Blob) || file.size < 22 || file.size > ZIP32_MAX) {
      throw new Error("This ZIP backup has an unsupported size.");
    }

    const tailOffset = Math.max(0, file.size - 22 - 0xffff);
    const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer());
    const tailView = new DataView(tail.buffer);
    let endOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tailView.getUint32(index, true) !== 0x06054b50) continue;
      const commentLength = tailView.getUint16(index + 20, true);
      if (index + 22 + commentLength === tail.length) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) throw new Error("This file is not a supported ZIP backup.");

    const endView = new DataView(tail.buffer, endOffset, 22);
    const diskNumber = endView.getUint16(4, true);
    const directoryDisk = endView.getUint16(6, true);
    const diskEntryCount = endView.getUint16(8, true);
    const entryCount = endView.getUint16(10, true);
    const directorySize = endView.getUint32(12, true);
    const directoryOffset = endView.getUint32(16, true);
    const endPosition = tailOffset + endOffset;
    if (diskNumber || directoryDisk || diskEntryCount !== entryCount || entryCount === 0xffff
      || directorySize === ZIP32_MAX || directoryOffset === ZIP32_MAX
      || directoryOffset + directorySize !== endPosition) {
      throw new Error("This ZIP backup uses a format that is not supported.");
    }

    const records = new Map();
    let cursor = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > directoryOffset + directorySize) throw new Error("The ZIP backup directory is incomplete.");
      const header = new Uint8Array(await file.slice(cursor, cursor + 46).arrayBuffer());
      const view = new DataView(header.buffer);
      if (view.getUint32(0, true) !== 0x02014b50) throw new Error("The ZIP backup directory is invalid.");

      const flags = view.getUint16(8, true);
      const method = view.getUint16(10, true);
      const checksum = view.getUint32(16, true);
      const compressedSize = view.getUint32(20, true);
      const size = view.getUint32(24, true);
      const nameLength = view.getUint16(28, true);
      const extraLength = view.getUint16(30, true);
      const commentLength = view.getUint16(32, true);
      const diskStart = view.getUint16(34, true);
      const localOffset = view.getUint32(42, true);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if ((flags & ~UTF8_FLAG) !== 0 || method !== 0 || compressedSize !== size || diskStart !== 0
        || size === ZIP32_MAX || compressedSize === ZIP32_MAX || localOffset === ZIP32_MAX
        || cursor + recordLength > directoryOffset + directorySize) {
        throw new Error("This ZIP backup uses compression or features that are not supported.");
      }

      const nameBytes = new Uint8Array(await file.slice(cursor + 46, cursor + 46 + nameLength).arrayBuffer());
      const name = decoder.decode(nameBytes);
      if (!validName(name) || records.has(name)) throw new Error("The ZIP backup contains an invalid file name.");

      const localHeaderBytes = new Uint8Array(await file.slice(localOffset, localOffset + 30).arrayBuffer());
      if (localHeaderBytes.length !== 30) throw new Error("The ZIP backup contains an incomplete file.");
      const localView = new DataView(localHeaderBytes.buffer);
      const localNameLength = localView.getUint16(26, true);
      const localExtraLength = localView.getUint16(28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const localNameBytes = new Uint8Array(await file.slice(localOffset + 30, localOffset + 30 + localNameLength).arrayBuffer());
      if (localView.getUint32(0, true) !== 0x04034b50
        || localView.getUint16(6, true) !== flags
        || localView.getUint16(8, true) !== method
        || localView.getUint32(14, true) !== checksum
        || localView.getUint32(18, true) !== compressedSize
        || localView.getUint32(22, true) !== size
        || decoder.decode(localNameBytes) !== name
        || dataOffset + size > directoryOffset) {
        throw new Error("The ZIP backup contains an invalid file record.");
      }

      records.set(name, { blob: file.slice(dataOffset, dataOffset + size), checksum });
      cursor += recordLength;
    }
    if (cursor !== directoryOffset + directorySize) throw new Error("The ZIP backup directory contains extra data.");

    return Object.freeze({
      names: () => [...records.keys()],
      async get(name) {
        const record = records.get(name);
        if (!record) return null;
        if (await crc32(record.blob) !== record.checksum) {
          throw new Error(`The ZIP backup file "${name}" failed its integrity check.`);
        }
        return record.blob;
      }
    });
  }

  window.VaultBackup = Object.freeze({ createZip, openZip });
})();
