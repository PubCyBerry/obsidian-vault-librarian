import type { App } from 'obsidian';
import type { ToolPermissionManager } from '../permissions/tool-permission-manager';
import type { ControllerEvent } from './agent-controller';
import type { SubagentState } from './subagent';

/** `skip` withdraws the card because the user sent a message that goes before this call. */
export type ApprovalDecision = 'approve' | 'reject' | 'always' | 'expired' | 'skip';

export interface ApprovalRequest {
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
	/** False when settings never let this tool skip approval (destructive MCP tools). */
	canAlways: boolean;
	/** What "Always allow" stores: the tool name, or a skill's key for a read inside a skill folder. */
	permissionKey: string;
	/** For write on an existing note: its current length. */
	existingLength?: number;
	/** The tool this call came from, such as `bash` for something a shell command is about to do. */
	calledFrom?: string;
	/** The sub-agent run asking: its title, its agent and its spawn_agent call. Absent for the main agent. */
	agentTitle?: string;
	agentType?: string;
	agentCallId?: string;
	/** Other approvals queued behind this one. */
	waiting: number;
	resolve: (decision: ApprovalDecision) => void;
}

/** Where a call comes from, for the approval it may need. */
export interface CallOrigin {
	calledFrom?: string;
	agent?: SubagentState;
}

/**
 * One approval card at a time: the main agent, sub-agents running side by side and the stages of
 * a shell pipeline can all ask at once, and the rest wait here in order. A call that reaches the
 * front may have been stopped meanwhile, or an earlier card may have made its key Always allow;
 * either way no card is shown for it.
 */
export class ApprovalQueue {
	/** The card on screen, if any. */
	pending: ApprovalRequest | null = null;
	private line: Promise<unknown> = Promise.resolve();
	private waiting = 0;

	constructor(
		private readonly deps: {
			app: App;
			permissions: ToolPermissionManager;
			emit: (event: ControllerEvent) => void;
		},
	) {}

	/** Waits for its turn, then shows the card and returns the answer. */
	ask(
		toolCallId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		origin: CallOrigin,
	): Promise<ApprovalDecision | 'allowed'> {
		this.waiting++;
		const card = this.pending;
		if (card) {
			card.waiting = this.waiting;
			this.deps.emit({ type: 'approval', request: card });
		}
		const perms = this.deps.permissions;
		const turn = this.line.then(async () => {
			this.waiting--;
			if (signal?.aborted) return 'expired' as const;
			if (perms.resolve(name, args) !== 'approval_required') return 'allowed' as const;
			const decision = await this.show(toolCallId, name, args, signal, origin);
			// Stored before the line moves on, so a card behind it for the same key is not shown.
			if (decision === 'always')
				await perms.setTool(perms.permissionKey(name, args), 'always_allow');
			return decision;
		});
		this.line = turn.catch(() => undefined);
		return turn;
	}

	private show(
		toolCallId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		{ calledFrom, agent }: CallOrigin,
	) {
		return new Promise<ApprovalDecision>((resolve) => {
			const finish = (decision: ApprovalDecision) => {
				if (this.pending?.toolCallId !== toolCallId) return;
				this.pending = null;
				signal?.removeEventListener('abort', onAbort);
				this.deps.emit({ type: 'approval', request: null });
				resolve(decision);
			};
			const onAbort = () => finish('expired');
			if (signal?.aborted) {
				resolve('expired');
				return;
			}
			signal?.addEventListener('abort', onAbort);
			const perms = this.deps.permissions;
			const existing =
				name === 'write' && typeof args.path === 'string'
					? this.deps.app.vault.getFileByPath(args.path)
					: null;
			const key = perms.permissionKey(name, args);
			this.pending = {
				toolCallId,
				name,
				args,
				canAlways: perms.canAlwaysAllow(name) && perms.canAlwaysAllow(key),
				permissionKey: key,
				existingLength: existing?.stat.size,
				...(calledFrom ? { calledFrom } : {}),
				...(agent
					? { agentTitle: agent.title, agentType: agent.agent, agentCallId: agent.callId }
					: {}),
				waiting: this.waiting,
				resolve: finish,
			};
			this.deps.emit({ type: 'state', state: 'awaiting-approval' });
			this.deps.emit({ type: 'approval', request: this.pending });
		});
	}

	/** Stop: the card on screen gets no answer. */
	expire(): void {
		this.pending?.resolve('expired');
	}

	/**
	 * A Send now message goes before the main agent's next call, so its card is withdrawn. A shell
	 * command or a sub-agent asking from inside its call has started already, so it keeps its card.
	 */
	skipMain(): void {
		const card = this.pending;
		if (card && !card.calledFrom && !card.agentCallId) card.resolve('skip');
	}
}
