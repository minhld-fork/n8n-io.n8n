/** The bytes of one message part, with transfer-encoding and charset already decoded. */
export class PartData {
	constructor(readonly buffer: Buffer) {}

	toString() {
		return this.buffer.toString('utf8');
	}
}
