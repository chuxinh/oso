import {
  Artifact,
  ArtifactNamespace,
  ArtifactType,
  Event,
  EventType,
} from "../db/orm-entities.js";
import {
  IEventRecorder,
  IncompleteEvent,
  IEventTypeStrategy,
  generateEventTypeStrategy,
  IncompleteArtifact,
  RecorderError,
} from "./types.js";
import {
  In,
  Repository,
  And,
  MoreThanOrEqual,
  LessThanOrEqual,
  QueryFailedError,
} from "typeorm";
import { InmemActorResolver } from "./actors.js";
import { UniqueArray, asyncBatch } from "../utils/array.js";
import { logger } from "../utils/logger.js";
import _ from "lodash";
import { PromisePubSub } from "../utils/pubsub.js";
import { Range, isWithinRange } from "../utils/ranges.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface BatchEventRecorderOptions {
  maxBatchSize: number;
  timeoutMs: number;
}

export type RecordResponse = string;

class EventTypeStorage<T> {
  private queue: UniqueArray<IncompleteEvent>;
  private pubsub: PromisePubSub<T, unknown>;

  static setup<X>(): EventTypeStorage<X> {
    const queue = new UniqueArray<IncompleteEvent>((event) => {
      return event.sourceId;
    });
    return new EventTypeStorage(queue);
  }

  private constructor(queue: UniqueArray<IncompleteEvent>) {
    this.queue = queue;
    this.pubsub = new PromisePubSub({
      // the recorder should be fast enough to record within a minute. We will
      // give it two to resolve.
      timeoutMs: 120000,
    });
  }

  pushAndWait(event: IncompleteEvent): Promise<T> {
    this.queue.push(event);

    return this.pubsub.sub(event.sourceId);
  }

  pop(): IncompleteEvent | undefined {
    return this.queue.pop();
  }

  popAll(): IncompleteEvent[] {
    const events = [];

    while (this.length > 0) {
      const event = this.pop();
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  emitResponse(sourceId: string, err: unknown | null, res: T) {
    return this.pubsub.pub(sourceId, err, res);
  }

  get length(): number {
    return this.queue.length;
  }
}

const defaultBatchEventRecorderOptions: BatchEventRecorderOptions = {
  maxBatchSize: 5000,
  // ten minute timeout seems sane for completing any db writes
  timeoutMs: 600000,
};

type FlusherCallback = () => Promise<void>;

export interface IFlusher {
  notify(size: number): void;
  clear(): void;
  onFlush(cb: FlusherCallback): void;
}

/**
 * A flusher that accumulates some arbitrary size (assumed to be the batch size)
 * and chooses to flush once that size is reached or a timeout has been met.
 */
export class TimeoutBatchedFlusher implements IFlusher {
  private timeout: NodeJS.Timeout | null;
  private timeoutMs: number;
  private waitMs: number;
  private size: number;
  private cb: FlusherCallback | undefined;
  private maxSize: number;
  private triggered: boolean;

  constructor(timeoutMs: number, maxSize: number) {
    if (timeoutMs < 100) {
      throw new Error("timeout is too short");
    }
    this.timeoutMs = timeoutMs;
    this.waitMs = timeoutMs;
    this.timeout = null;
    this.size = 0;
    this.maxSize = maxSize;
    this.triggered = false;
  }

  notify(size: number): void {
    this.size += size;

    // if the size is 0 then this was called without anything in the queue. That
    // means we should slow down processing the queue.
    if (this.size == 0) {
      if (this.waitMs == 0) {
        this.waitMs = this.timeoutMs / 2;
      }
      this.waitMs += this.waitMs;
    } else {
      this.waitMs = this.timeoutMs;
    }

    // We should allow the flush notification to get pushed while the size of
    // the flush is small.
    if (this.size < this.maxSize) {
      this.resetTimeout();
    }
  }

  private resetTimeout() {
    // Only reset the timeout if the flusher is currently untriggered. A
    // triggered state means that this flusher is executing the callback
    if (!this.triggered) {
      if (this.timeout) {
        clearTimeout(this.timeout);
      }

      this.timeout = setTimeout(() => {
        // It is expected that the consuming class will clear the flusher.
        this.triggered = true;

        // Reset size which is just a count of notifications This allows the
        // timeout to backoff if the notify function is continously called and
        // this.size remains 0
        this.size = 0;

        if (this.cb) {
          this.cb()
            .then(() => {
              this.triggered = false;
              this.notify(0);
            })
            .catch((err) => {
              // This should not happen and will trigger a failure. It is
              // expected that the callback will capture all errors.
              logger.error("recorder is not catching some errors");
              logger.error(err);

              // Thiw will cause an uncaughtException error to be thrown and the
              // entire application to stop.
              throw err;
            });
        }
      }, this.waitMs);
    }
  }

  onFlush(cb: FlusherCallback): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    this.cb = cb;
  }

  clear(): void {
    this.size = 0;
    this.waitMs = 0;
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    this.timeout = null;
    this.triggered = false;
  }
}

type KnownEventStorage = {
  loaded: boolean;
  known: Record<string, boolean>;
};

export class BatchEventRecorder implements IEventRecorder {
  private eventTypeStrategies: Record<string, IEventTypeStrategy>;
  private eventTypeStorage: Record<string, EventTypeStorage<RecordResponse>>;
  private knownEventsStorage: Record<string, KnownEventStorage>;
  private options: BatchEventRecorderOptions;
  private actorDirectory: InmemActorResolver;
  private eventRepository: Repository<Event>;
  private artifactRepository: Repository<Artifact>;
  private namespaces: ArtifactNamespace[];
  private types: ArtifactType[];
  private actorsLoaded: boolean;
  private flusher: IFlusher;
  private pubsub: PromisePubSub<void, unknown>;
  private range: Range | undefined;
  private emitter: EventEmitter;
  private closing: boolean;

  constructor(
    eventRepository: Repository<Event>,
    artifactRepository: Repository<Artifact>,
    flusher: IFlusher,
    options?: BatchEventRecorderOptions,
  ) {
    this.eventRepository = eventRepository;
    this.artifactRepository = artifactRepository;
    this.eventTypeStrategies = {};
    this.eventTypeStorage = {};
    this.actorDirectory = new InmemActorResolver();
    this.options = _.merge(defaultBatchEventRecorderOptions, options);
    this.namespaces = [];
    this.types = [];
    this.actorsLoaded = false;
    this.flusher = flusher;
    this.pubsub = new PromisePubSub({
      timeoutMs: this.options.timeoutMs,
    });
    this.knownEventsStorage = {};
    this.emitter = new EventEmitter();
    this.closing = false;
    // Arbitrarily set to an early time

    // Setup flush event handler
    this.flusher.onFlush(async () => {
      logger.debug(`flushing all queued events`);
      try {
        await this.flushAll();
        logger.debug("flush cycle completed");
        this.emitter.emit("flush");
      } catch (err) {
        logger.error(`error caught flushing ${err}`);
        logger.error(err);
        this.emitter.emit("error", err);
      }
    });
  }

  setActorScope(namespaces: ArtifactNamespace[], types: ArtifactType[]) {
    this.namespaces = namespaces;
    this.types = types;
  }

  setRange(range: Range) {
    // This is used to optimize queries.
    this.range = range;

    // Invalidate any known event storage
    this.knownEventsStorage = {};
  }

  private async loadEvents(eventType: EventType) {
    if (!this.range) {
      throw new Error("recorder needs a range to load events");
    }

    if (!this.knownEventsStorageForType(eventType).loaded) {
      logger.debug(`Loading existing events for ${eventType} (if any)`);
      // find all of the events that need for a given time range
      const strategy = this.getEventTypeStrategy(eventType);
      const where = strategy.all(this.actorDirectory);

      where.time = And(
        MoreThanOrEqual(this.range.startDate.toJSDate()),
        LessThanOrEqual(this.range.endDate.toJSDate()),
      );

      // Find existing events (for idempotency)
      const existingEvents = (await this.eventRepository.find({
        where: where,
        select: {
          sourceId: true,
        },
      })) as Pick<Event, "sourceId">[];

      const lookup = existingEvents.reduce<Record<string, boolean>>(
        (lookup, curr) => {
          lookup[curr.sourceId] = true;
          return lookup;
        },
        {},
      );

      console.log(`existing events length ${existingEvents.length}`);

      this.knownEventsStorage[eventType] = {
        loaded: true,
        known: lookup,
      };
    }
  }

  private knownEventsStorageForType(eventType: EventType): KnownEventStorage {
    const storage = this.knownEventsStorage[eventType] || {
      loaded: false,
      known: {},
    };
    return storage;
  }

  private markEventAsKnown(event: Event | IncompleteEvent) {
    const storage = this.knownEventsStorageForType(event.type);
    if (!storage.loaded) {
      throw new Error(
        `eventType ${event.type} hasn't been loaded for the recorder`,
      );
    }
    storage.known[event.sourceId] = true;
  }

  private isKnownEvent(event: IncompleteEvent) {
    const storage = this.knownEventsStorageForType(event.type);
    return storage.known[event.sourceId] !== undefined;
  }

  private async loadActors(flushId: string): Promise<void> {
    if (this.namespaces.length === 0) {
      throw new Error("scope of recording must be set");
    }

    logger.debug(`${flushId}: loading all artifacts and contributors`);

    // Load all of the artifacts
    const artifacts = await this.artifactRepository.find({
      where: {
        namespace: In(this.namespaces),
        type: In(this.types),
      },
    });

    let count = 0;
    for await (const raw of artifacts) {
      const artifact = raw as Artifact;
      this.actorDirectory.loadArtifact(artifact);
      count += 1;
    }
    logger.debug(`${flushId}: loaded ${count} artifacts`);
    this.actorsLoaded = true;
  }

  // Records events into a queue and periodically flushes that queue as
  // transactions to the database.
  registerEventType(eventType: EventType, strategy: IEventTypeStrategy): void {
    this.eventTypeStrategies[eventType.toString()] = strategy;
  }

  record(event: IncompleteEvent): Promise<RecordResponse> {
    if (this.closing) {
      throw new RecorderError("recorder is closing. should be more writes");
    }
    // Queue an event for writing
    const queue = this.getEventTypeStorage(event.type);
    const promise = queue.pushAndWait(event);

    // Upon the first "record" begin the flush sequence
    this.scheduleFlush(1);
    return promise;
  }

  addListener(listener: string, callback: (...args: any) => void) {
    return this.emitter.on(listener, callback);
  }

  removeListener(listener: string, callback: (...args: any) => void) {
    this.emitter.removeListener(listener, callback);
  }

  private scheduleFlush(size: number) {
    this.flusher.notify(size);
  }

  private getEventTypeStrategy(eventType: EventType): IEventTypeStrategy {
    const typeString = eventType.toString();
    const strategy = this.eventTypeStrategies[typeString];

    if (!strategy) {
      return generateEventTypeStrategy(eventType);
    }
    return strategy;
  }

  private async flushAll() {
    // Wait for all queues to complete in series
    for (const eventType in this.eventTypeStorage) {
      await this.flushType(eventType as EventType);
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      throw new RecorderError("there should only be one call to close()");
    }

    // Lock the recorder
    this.closing = true;
    logger.debug("closing the recorder");
    const all: Promise<void>[] = [];

    for (const eventType in this.eventTypeStorage) {
      all.push(this.wait(eventType as EventType));
    }

    await Promise.all(all);

    this.flusher.clear();
    return;
  }

  async wait(eventType: EventType): Promise<void> {
    const storage = this.getEventTypeStorage(eventType);
    if (storage.length === 0) {
      return;
    }
    return this.pubsub.sub(eventType);
  }

  private async flushType(eventType: EventType) {
    const flushId = randomUUID();
    logger.debug(
      `${flushId}: Waiting for all ${eventType.toString()} events to be recorded`,
    );
    if (!this.actorsLoaded) {
      await this.loadActors(flushId);
    }

    // Wait for a specific event type queue to complete
    const eventTypeStorage = this.getEventTypeStorage(eventType);
    if (eventTypeStorage.length === 0) {
      logger.debug(`queue empty for ${eventType}`);
      return;
    }

    logger.info(
      `emptying queue for ${eventType.toString()} with ${
        eventTypeStorage.length
      } items`,
    );
    const processing = eventTypeStorage.popAll();

    try {
      await this.processEvents(flushId, eventType, processing);
      this.pubsub.pub(eventType, null);
    } catch (err) {
      logger.error(
        "error caught while processing one of the events in a batch",
        err,
      );
      this.pubsub.pub(eventType, err);

      // Report errors to all of the promises listening on specific events
      for (const event of processing) {
        eventTypeStorage.emitResponse(event.sourceId, err, "");
      }
      throw err;
    }
  }

  private async processEvents(
    flushId: string,
    eventType: EventType,
    processing: IncompleteEvent[],
  ): Promise<void> {
    await this.loadEvents(eventType);

    // Get the date range for the currently queued items
    const eventTypeStorage = this.getEventTypeStorage(eventType);
    let startDate = processing[0].time;
    let endDate = processing[0].time;
    processing.forEach((event) => {
      if (startDate > event.time) {
        startDate = event.time;
      }

      if (endDate < event.time) {
        endDate = event.time;
      }
    });

    const newEvents = [];
    const queuedArtifacts: UniqueArray<IncompleteArtifact> = new UniqueArray(
      (a) => `${a.name}::${a.namespace}`,
    );

    // Filter duplicates
    for (const event of processing) {
      // For now we ignore events outside the range we're recording and any known events.
      if (!this.isKnownEvent(event) && isWithinRange(this.range!, event.time)) {
        queuedArtifacts.push(event.to);
        if (event.from) {
          queuedArtifacts.push(event.from);
        }
        newEvents.push(event);
      } else {
        // Resolve any existing subscriptions for this event's creation
        eventTypeStorage.emitResponse(event.sourceId, null, event.sourceId);
      }
    }

    logger.debug(
      `skipping ${processing.length - newEvents.length} existing events`,
    );

    // Create all of the new actors involved
    const newArtifacts = this.actorDirectory.unknownArtifactsFrom(
      queuedArtifacts.items(),
    );

    // Write all the new artifacts
    await asyncBatch(newArtifacts, this.options.maxBatchSize, async (batch) => {
      logger.debug("writing new artifacts");
      //console.log(batch);
      const artifacts = Artifact.create(batch);
      return this.artifactRepository.insert(artifacts);
    });

    if (newArtifacts.length > 0) {
      await this.loadActors(flushId);
    }

    logger.debug(`about to start writing to db in batch ${newEvents.length}`);

    await asyncBatch(
      newEvents,
      this.options.maxBatchSize,
      async (batch, batchLength) => {
        logger.info(`preparing to write a batch of ${batchLength} events`);
        const events = await Promise.all(
          batch.map(async (e) => {
            const artifactId = await this.actorDirectory.resolveArtifactId(
              e.to,
            );
            let contributorRef: { id: number } | null = null;
            if (e.from) {
              contributorRef = {
                id: await this.actorDirectory.resolveArtifactId(e.from),
              };
            }

            const input = this.eventRepository.create({
              time: e.time.toJSDate(),
              to: {
                id: artifactId,
              },
              from: contributorRef,
              type: e.type,
              amount: e.amount,
              sourceId: e.sourceId,
            });
            return input;
          }),
        );

        try {
          const result = await this.eventRepository.insert(events);
          if (result.identifiers.length !== batchLength) {
            throw new RecorderError(
              `recorder writes failed. Expected ${batchLength} writes but only received ${result.identifiers.length}`,
            );
          }
          logger.debug(
            `completed writing batch of ${result.identifiers.length}`,
          );
          events.forEach((e) => {
            // Mark as known event
            this.markEventAsKnown(e);

            // Notify any subscribers that the event has been recorded
            eventTypeStorage.emitResponse(e.sourceId, null, e.sourceId);
          });
        } catch (err) {
          if (err instanceof QueryFailedError) {
            if (err.message.indexOf("duplicate") !== -1) {
              console.log("attempted to write a duplicate event");
            }
          }
          events.forEach((e) => {
            // Notify any subscribers that the event has failed to record
            eventTypeStorage.emitResponse(e.sourceId, e, "");
          });
          throw err;
        }
      },
    );
  }

  protected getEventTypeStorage(
    eventType: EventType,
  ): EventTypeStorage<RecordResponse> {
    const typeString = eventType.toString();
    let queue = this.eventTypeStorage[typeString];
    if (!queue) {
      this.eventTypeStorage[typeString] =
        EventTypeStorage.setup<RecordResponse>();
      queue = this.eventTypeStorage[typeString];
    }
    return queue;
  }
}
