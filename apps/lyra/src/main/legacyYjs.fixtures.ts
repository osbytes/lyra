/**
 * `doc.yjs` logs written by yjs 13.6 (the version Lyra used), for the reader's unit test and the
 * smoke test's migration case.
 */

export const legacyLog = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'))

/**
 * A session over many updates: title, notes with a deletion, tags, a speaker renamed, a line
 * whose text was edited after it was written, and the speaker counter.
 */
export const PLAIN =
  'OQAAAAEDBwAnAQRtZXRhBHRhZ3MAJwEEbWV0YQhzcGVha2VycwEEAQV0aXRsZQ1EZXNpZ24gcmV2aWV3AB8AAAABAQcPBAEFbm90ZXMRSGVsbG8gY3J1ZWwgd29ybGQABgAAAAABBwEUBhIAAAABAQcgCAAHAAF3BmRlc2lnbgANAAAAAQEHIScABwECYzEBABoAAAABAQciKAAHIQRuYW1lAXcJU3BlYWtlciAxABIAAAABAQcjqAciAXcDU2FtAQcBIgEVAAAAAQEHJCgAByEJY29uZmlybWVkAXgALgAAAAEBByUoAAchB21hdGNoZXMBdQF2AghwZXJzb25JZHcCcDEFc2NvcmV8P0AAAABvAAAAAQcHJgcBCnRyYW5zY3JpcHQBKAAHJgJpZAF3AnMwKAAHJgVzdGFydAF8P8AAACgAByYHY2x1c3RlcgF3AmMxJwAHJgR0ZXh0AgQAByoISGkgdGhlcmUoAAcmCG9yaWdpbmFsAXcISGkgdGhlcmUADAAAAAEBBzTEBywHLQEsABoAAAABAQc1KAEEbWV0YQpzcGVha2VyU2VxAX0CAA=='

/**
 * Clients 1 and 2 both start from "ac". At once, 1 inserts "X" and 2 inserts "Y" between the
 * letters, and each sets `meta.name`. Then a full resync repeats the whole state.
 */
export const CONCURRENT =
  'EAAAAAEBAQAEAQV0aXRsZQJhYwAZAAAAAQEBAigBBG1ldGEEbmFtZQF3BWZpcnN0AAwAAAABAQEDxAEAAQEBWAAVAAAAAQEBBKgBAgF3BmZyb20gMQEBAQIBHAAAAAECAgDEAQABAQFZqAECAXcGZnJvbSAyAQEBBAFIAAAAAgICAMQBAAEBAVmoAQIBdwZmcm9tIDIFAQAEAQV0aXRsZQFhhAEAAWMhAQRtZXRhBG5hbWUBxAEAAQEBWKEBAgEBAQICAQQB'

/** "Kept", then " and lost" in a second frame cut short by a crash. */
export const TORN = 'EgAAAAEBCQAEAQVub3RlcwRLZXB0ABIAAAABAQkEhAkDCSBhbmQgbG8='
