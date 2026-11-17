import { MODE_FRAMES, type OrbState, resolvePreset } from 'thinking-orbs/engine';

export type { OrbState } from 'thinking-orbs/engine';

/** The size the orbs are tuned for beside a line of text, in CSS pixels. */
const SIZE = 20;

/** How long one motion dissolves into the next. */
const FADE_MS = 700;

/**
 * The thought orb of a run at work (LIB-FEAT-308): a small dotted sphere whose motion says what the
 * agent is doing. The geometry of each frame is Jakub Antalik's thinking-orbs (MIT), through its
 * engine entry, which has no React in it; the dots are painted here in the theme's accent color,
 * nearer ones stronger, so one painter serves light and dark themes.
 *
 * Every orb reads the page's clock, so one made anew by a redraw goes on where the last one was.
 * Its loop ends when its canvas leaves the page, and the browser holds it while the window is
 * hidden. It moves under reduced motion too, as the spinner it replaces does: it is the sign
 * that work goes on.
 */
export class Orb {
	readonly el: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D | null;
	private readonly ratio: number;
	private readonly color: string;
	private state: OrbState;
	/** The motion it is leaving and when it began to, while the two dissolve into each other. */
	private from: { state: OrbState; at: number } | null = null;

	constructor(parent: HTMLElement, state: OrbState = 'working') {
		this.state = state;
		this.el = parent.createEl('canvas', {
			cls: 'librarian-orb',
			attr: { 'aria-hidden': 'true' },
		});
		this.ratio = Math.min(2, window.devicePixelRatio || 1);
		this.el.width = this.el.height = Math.round(SIZE * this.ratio);
		this.ctx = this.el.getContext('2d');
		this.color = getComputedStyle(this.el).color;
		this.tick();
	}

	/**
	 * Another motion for another kind of work. The one it had fades out as the new one fades in,
	 * so the orb never jumps from one shape to another; the clock runs on.
	 */
	set(state: OrbState, fade = true): void {
		if (state === this.state) return;
		this.from = fade ? { state: this.state, at: performance.now() } : null;
		this.state = state;
	}

	private readonly tick = (): void => {
		const ctx = this.ctx;
		if (!ctx || !this.el.isConnected) return;
		const now = performance.now();
		ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
		ctx.clearRect(0, 0, SIZE, SIZE);
		ctx.fillStyle = ctx.strokeStyle = this.color;
		const f = this.from ? Math.min(1, (now - this.from.at) / FADE_MS) : 1;
		const eased = f * f * (3 - 2 * f);
		if (this.from && f < 1) this.paint(this.from.state, now, 1 - eased);
		else this.from = null;
		this.paint(this.state, now, eased);
		window.requestAnimationFrame(this.tick);
	};

	/** One motion's frame at this moment, its ink scaled by `weight`. */
	private paint(state: OrbState, now: number, weight: number): void {
		const ctx = this.ctx;
		if (!ctx || weight <= 0) return;
		const { mode, speed, opts } = resolvePreset(state, SIZE);
		const frame = MODE_FRAMES[mode](SIZE, (now / 1000) * speed, opts);
		// The engine's ink runs from 0, the darkest, to 1: here it is how much of the color shows.
		const ink = (white: number, a = 1) => (1 - Math.min(1, Math.max(0, white))) * a * weight;
		for (const l of frame.lines) {
			ctx.globalAlpha = ink(l.white, l.a);
			ctx.lineWidth = l.w;
			ctx.beginPath();
			ctx.moveTo(l.x1, l.y1);
			ctx.lineTo(l.x2, l.y2);
			ctx.stroke();
		}
		for (const d of frame.dots) {
			ctx.globalAlpha = ink(d.white, d.a);
			ctx.beginPath();
			ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
			ctx.fill();
		}
	}
}
