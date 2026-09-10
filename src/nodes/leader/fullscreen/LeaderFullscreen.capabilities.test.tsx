import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaderFullscreen, type LeaderFullscreenProps } from './LeaderFullscreen.tsx';
import { LEADER_DEFAULT_DATA, type LeaderData, type TaskPlanItem } from '../types.ts';
import { DashboardSurface } from '../../render/DashboardSurface.tsx';

function props(data: Partial<LeaderData> = {}): LeaderFullscreenProps {
  return { data: { ...LEADER_DEFAULT_DATA, ...data }, isWorking: false, onUpdateData: vi.fn(), onExit: vi.fn(),
    input: '', onInputChange: vi.fn(), onPromptSubmit: vi.fn(), onPromptKeyDown: vi.fn(),
    promptPlaceholder: 'Guide the leader', promptSubmitLabel: 'Send', promptSubmitDisabled: false, promptSubmitActive: false,
    onStop: vi.fn(), messageContextSelection: null, activateMessageSelection: vi.fn(), setMessageContextSelection: vi.fn(),
    exitMessageSelection: vi.fn(), onOpenSkillFlyout: vi.fn(), skillFlyoutAnchorRef: createRef(), toolbarSlot: null, bannerSlot: null };
}
const task = (status: TaskPlanItem['status']): TaskPlanItem => ({ taskId: status, title: status, description: '', priority: 'medium', status,
  executor: 'leader', minionSessionKey: null, result: null, cost: 0, createdAt: 0, completedAt: null, sessionSummary: '' });

afterEach(() => vi.unstubAllGlobals());

describe('Fullscreen leader capabilities', () => {
  it('mounts the live change viewer only when the Changes tab is selected', () => {
    render(<LeaderFullscreen {...props({ sessionKey: 'live-session', worktreeIsolation: false })}
      changesSlot={<p>Current workspace edits</p>} />);
    expect(screen.queryByText('Current workspace edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle context panel' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace changes' }));
    expect(screen.getByText('Current workspace edits')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close context panel' }));
    expect(screen.queryByText('Current workspace edits')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle context panel' }));
    expect(screen.getByText('Current workspace edits')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.queryByText('Current workspace edits')).toBeNull();
  });
  it('shows execution when work arrives and preserves the reader’s explicit panel choice', () => {
    const { rerender } = render(<LeaderFullscreen {...props()} />);
    const execution = screen.getByRole('button', { name: 'Toggle execution panel' });
    expect(execution).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Toggle context panel' })).toHaveAttribute('aria-expanded', 'false');
    rerender(<LeaderFullscreen {...props({ taskPlan: [task('running')] })} />);
    expect(execution).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close execution panel' }));
    expect(execution).toHaveFocus();
    rerender(<LeaderFullscreen {...props({ taskPlan: [task('completed')] })} />);
    expect(execution).toHaveAttribute('aria-expanded', 'false');
  });

  it('dismisses compact panels before fullscreen and restores focus to their toggle', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const options = props();
    render(<LeaderFullscreen {...options} />);
    const context = screen.getByRole('button', { name: 'Toggle context panel' });
    fireEvent.click(context);
    expect(context).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close context panel' }), { key: 'Escape' });
    expect(context).toHaveAttribute('aria-expanded', 'false');
    expect(context).toHaveFocus();
    expect(options.onExit).not.toHaveBeenCalled();
    fireEvent.click(context);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss side panel' }));
    expect(context).toHaveAttribute('aria-expanded', 'false');
  });

  it('surfaces nested questions and preserves a draft when switching to conversation', () => {
    const renderState = { layout: {}, components: [{ id: 'section', type: 'section' as const, title: 'Decision', components: [
      { id: 'question', type: 'form' as const, title: 'Next step', fields: [{ id: 'answer', kind: 'text' as const, label: 'Your answer' }] },
    ] }] };
    render(<LeaderFullscreen {...props({ renderState })} dashboardSlot={<DashboardSurface renderState={renderState} />} />);
    fireEvent.click(screen.getByRole('button', { name: /1 question needs your response/ }));
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Fix keyboard navigation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(screen.getByLabelText('Your answer')).toHaveValue('Fix keyboard navigation');
  });

  it('opens the actual review panel from attention after the user inspects another tab', () => {
    render(<LeaderFullscreen {...props({ worktreeIsolation: true, approvalPending: true, approvalSummary: 'Ready for review' })}
      configSlot={<button>Review integration</button>} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('button', { name: /Changes are ready for review/ }));
    expect(screen.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Review integration' })).toBeVisible();
  });

  it('only counts completed work as success and exposes attention states', () => {
    render(<LeaderFullscreen {...props({ taskPlan: ['completed', 'failed', 'blocked', 'starting', 'cancelled'].map(s => task(s as TaskPlanItem['status'])) })} />);
    const overview = screen.getByTestId('drawer-panel-overview');
    expect(overview).toHaveTextContent('1/5');
    expect(overview).toHaveTextContent('Needs attention2');
    expect(overview).toHaveTextContent('Cancelled1');
  });

  it('opens minion details without closing the fullscreen workspace', () => {
    const onReveal = vi.fn(); const onExit = vi.fn();
    render(<LeaderFullscreen {...props({ taskPlan: [{ ...task('running'), executor: 'minion', minionSessionKey: 'worker-1' }] })}
      onRevealMinion={onReveal} onExit={onExit} minionsSlot={<p>Worker transcript</p>} />);
    fireEvent.click(screen.getByTestId('minion-row-worker-1'));
    expect(onReveal).toHaveBeenCalledWith('worker-1');
    expect(screen.getByText('Worker transcript')).toBeVisible();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('shows connected source content and supports keyboard tab navigation', () => {
    render(<LeaderFullscreen {...props()} contextItems={[{ nodeId: 'brief', nodeType: 'markdown', label: 'Release brief', content: 'Preserve review gates.' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle context panel' }));
    const overview = screen.getByRole('tab', { name: 'Overview' });
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    const sources = screen.getByRole('tab', { name: 'Sources · 1' });
    expect(sources).toHaveFocus();
    expect(sources).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', sources.id);
    expect(screen.getByText('Release brief')).toBeInTheDocument();
    expect(screen.getByText('Preserve review gates.')).toBeInTheDocument();
  });

  it('uses truthful idle empty state and restores focus when closed', () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const { unmount } = render(<LeaderFullscreen {...props({ sessionKey: 'idle-session', status: 'idle' })} />);
    expect(screen.getByText('Continue the conversation')).toBeInTheDocument();
    expect(screen.queryByText('Leader is thinking...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toHaveFocus();
    unmount(); expect(trigger).toHaveFocus(); trigger.remove();
  });

  it('resizes panes with the keyboard and resets to their default', () => {
    render(<LeaderFullscreen {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle execution panel' }));
    const divider = screen.getByRole('separator', { name: 'Resize activity rail' });
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(divider).toHaveAttribute('aria-valuenow', '266');
    fireEvent.keyDown(divider, { key: 'Enter' });
    expect(divider).toHaveAttribute('aria-valuenow', '250');
  });
});
