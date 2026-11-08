// Deliberate compile-time failures ensure the generated shapes reject basic drift.
import type { ObservationEvent, SignCommand, SignAck } from "./types.generated";
import { fire, command, ack } from "./samples.generated";

// @ts-expect-error The sequence is a number, never a numeric string.
const badSequence: ObservationEvent = { ...fire, source_sequence: "17" };
// @ts-expect-error The server maps source_id to a zone; senders cannot choose it.
const extraZone: ObservationEvent = { ...fire, zone_id: "Z-B" };
// @ts-expect-error Unsupported controller state must not cross the wire.
const badMode: SignCommand = { ...command, faces: [{ ...command.faces[0], mode: "SAFE" }] };
// @ts-expect-error HTTP acceptance is not a valid terminal application status.
const badAck: SignAck = { ...ack, status: "RECEIVED" };
const { confidence, ...withoutConfidence } = fire;
// @ts-expect-error Fields that allow null are still required.
const missingNullable: ObservationEvent = withoutConfidence;
// @ts-expect-error C02 only supports schema version 1.
const badVersion: ObservationEvent = { ...fire, schema_version: 2 };

void [badSequence, extraZone, badMode, badAck, missingNullable, badVersion, confidence];
