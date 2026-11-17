// The shared buffer between the script host and its worker: Int32 words, then one BigInt64 word.
//   DONE       the sequence number of the last batch the worker finished
//   READY      1 once the worker is listening for batches
//   RUN_SEQ    the batch of the call the worker is running (or ran last)
//   RUN_INDEX  that call's index in its batch, -1 between batches
//   CANCEL     the host gave up on every batch up to this sequence number
//   HANG       a word nothing ever notifies, for the test hook that stands in for a native hang
// The BigInt64 word holds the running call's start time from process.hrtime.bigint(), a clock
// every thread of the process shares.
export const SLOT = { DONE: 0, READY: 1, RUN_SEQ: 2, RUN_INDEX: 3, CANCEL: 4, HANG: 5 };

const INT_WORDS = 8;
export const BUFFER_BYTES = INT_WORDS * 4 + 8;

export const startTimes = (buffer) => new BigInt64Array(buffer, INT_WORDS * 4, 1);
