/**
 * Decodes a DER-encoded ASN.1 UTF8String (tag 0x0C). Fulcio writes certificate extensions
 * 1.3.6.1.4.1.57264.1.8 and above this way. Returns undefined for anything malformed so the
 * caller treats the field as absent and fails closed.
 */
export function decodeDerUtf8String(bytes: Uint8Array): string | undefined {
  if (bytes.length < 2 || bytes[0] !== 0x0c) {
    return undefined;
  }
  let offset = 1;
  let length = bytes[offset] ?? 0;
  offset += 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || bytes.length < offset + count) {
      return undefined;
    }
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + (bytes[offset] ?? 0);
      offset += 1;
    }
  }
  if (offset + length !== bytes.length) {
    return undefined;
  }
  return Buffer.from(bytes.subarray(offset)).toString("utf8");
}

/** Encodes a string as a DER UTF8String. Used by tests to build certificate fixtures. */
export function encodeDerUtf8String(value: string): Uint8Array {
  const body = Buffer.from(value, "utf8");
  let header: number[];
  if (body.length < 0x80) {
    header = [0x0c, body.length];
  } else {
    const lengthBytes: number[] = [];
    let remaining = body.length;
    while (remaining > 0) {
      lengthBytes.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    header = [0x0c, 0x80 | lengthBytes.length, ...lengthBytes];
  }
  return Buffer.concat([Buffer.from(header), body]);
}

interface Tlv {
  tag: number;
  /** Offset of the first content byte. */
  start: number;
  /** Offset just past the last content byte. */
  end: number;
}

/** Reads one DER tag-length-value at `offset`, or undefined when it does not fit in `limit`. */
function readTlv(bytes: Uint8Array, offset: number, limit: number): Tlv | undefined {
  if (offset + 2 > limit) {
    return undefined;
  }
  const tag = bytes[offset] ?? 0;
  if ((tag & 0x1f) === 0x1f) {
    return undefined;
  }
  let length = bytes[offset + 1] ?? 0;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > limit) {
      return undefined;
    }
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + (bytes[start + i] ?? 0);
    }
    start += count;
  }
  const end = start + length;
  return end <= limit ? { tag, start, end } : undefined;
}

/** The TLVs directly inside a constructed value, or undefined when they do not tile it exactly. */
function children(bytes: Uint8Array, parent: Tlv): Tlv[] | undefined {
  const out: Tlv[] = [];
  let offset = parent.start;
  while (offset < parent.end) {
    const child = readTlv(bytes, offset, parent.end);
    if (!child) {
      return undefined;
    }
    out.push(child);
    offset = child.end;
  }
  return out;
}

function decodeOid(bytes: Uint8Array): number[] | undefined {
  if (bytes.length === 0) {
    return undefined;
  }
  const arcs: number[] = [];
  let value = 0;
  for (const byte of bytes) {
    value = value * 128 + (byte & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER / 128) {
      return undefined;
    }
    if (!(byte & 0x80)) {
      arcs.push(value);
      value = 0;
    }
  }
  if ((bytes[bytes.length - 1] ?? 0) & 0x80) {
    return undefined;
  }
  const first = arcs.shift() ?? 0;
  const top = first < 80 ? Math.floor(first / 40) : 2;
  return [top, first - top * 40, ...arcs];
}

/**
 * The extensions of a DER X.509 certificate as `{ oid, value }`, where `value` is the
 * content of the extension's OCTET STRING (the same bytes sigstore's `verify()` exposes).
 * This does not check any signature: callers use it only to build a candidate that is
 * verified afterwards. Returns undefined for anything that is not a well-formed certificate.
 */
export function readCertificateExtensions(
  der: Uint8Array,
): Array<{ oid: { id: number[] }; value: Uint8Array }> | undefined {
  const certificate = readTlv(der, 0, der.length);
  if (certificate?.tag !== 0x30 || certificate.end !== der.length) {
    return undefined;
  }
  const tbs = children(der, certificate)?.[0];
  const fields = tbs?.tag === 0x30 ? children(der, tbs) : undefined;
  const wrapper = fields?.find((field) => field.tag === 0xa3);
  if (!wrapper) {
    return fields ? [] : undefined;
  }
  const [list, ...rest] = children(der, wrapper) ?? [];
  const extensions = list?.tag === 0x30 && rest.length === 0 ? children(der, list) : undefined;
  if (!extensions) {
    return undefined;
  }
  const out: Array<{ oid: { id: number[] }; value: Uint8Array }> = [];
  for (const extension of extensions) {
    const parts = extension.tag === 0x30 ? children(der, extension) : undefined;
    const oid = parts?.[0];
    const value = parts?.[parts.length - 1];
    if (
      !parts ||
      parts.length < 2 ||
      parts.length > 3 ||
      oid?.tag !== 0x06 ||
      value?.tag !== 0x04
    ) {
      return undefined;
    }
    const id = decodeOid(der.subarray(oid.start, oid.end));
    if (!id) {
      return undefined;
    }
    out.push({ oid: { id }, value: der.subarray(value.start, value.end) });
  }
  return out;
}
