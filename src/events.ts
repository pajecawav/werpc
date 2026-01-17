export type EventsMap = Record<string, unknown[]>;

type EventListener<TEvent extends keyof TEvents, TEvents extends EventsMap> = (
	...args: TEvents[TEvent]
) => void;

type EventListeners<TEvents extends EventsMap> = {
	[TEvent in keyof TEvents]?: Set<EventListener<TEvent, TEvents>>;
};

export class EventEmitter<TEvents extends EventsMap> {
	private listeners: EventListeners<TEvents> = {};

	public on<TEvent extends keyof TEvents>(
		event: TEvent,
		cb: (...args: TEvents[TEvent]) => void,
		signal?: AbortSignal,
	): VoidFunction {
		if (!this.listeners[event]) {
			this.listeners[event] = new Set();
		}

		this.listeners[event].add(cb);

		const unsub = () => this.off(event, cb);
		signal?.addEventListener("abort", unsub);

		return unsub;
	}

	public once<Name extends keyof TEvents>(
		name: Name,
		cb: (...args: TEvents[Name]) => void,
		signal?: AbortSignal,
	): VoidFunction {
		const newCb = (...args: TEvents[Name]) => {
			this.off(name, newCb);
			cb(...args);
		};

		return this.on(name, newCb, signal);
	}

	public off<Name extends keyof TEvents>(name: Name, cb: VoidFunction) {
		const listeners = this.listeners[name];

		if (!listeners) {
			return;
		}
		listeners.delete(cb);
	}

	public offAll<Name extends keyof TEvents>(name: Name) {
		this.listeners[name]?.clear();
	}

	public emit<Name extends keyof TEvents>(name: Name, ...args: TEvents[Name]) {
		const listeners = this.listeners[name];

		if (!listeners) {
			return;
		}

		for (const cb of listeners) {
			cb(...args);
		}
	}
}

export const on = <TEvent extends keyof TEvents, TEvents extends EventsMap>(
	emitter: EventEmitter<TEvents>,
	event: TEvent,
): AsyncIterable<TEvents[TEvent]> => {
	return {
		[Symbol.asyncIterator]() {
			return {
				next: () => {
					return new Promise(resolve => {
						emitter.once(event, (...args) => {
							resolve({ value: args, done: false });
						});
					});
				},
			};
		},
	};
};

export const once = <TEvent extends keyof TEvents, TEvents extends EventsMap>(
	emitter: EventEmitter<TEvents>,
	event: TEvent,
): Promise<TEvents[TEvent]> => {
	return new Promise(resolve => {
		emitter.once(event, (...args) => {
			resolve(args);
		});
	});
};
