import { useCallback, useEffect, useState } from 'react';
import { useBishopStore } from '../store/useBishopStore';
import { api } from '../api/client';
import type { Task, TopicResearch } from '../types';
import { Check, Loader2, Sparkles, WarningCircle, X } from './icons';
import { TaskComplexityDot } from './taskStatus';
import { Modal } from './ui';

export function RefineTopicDialog() {
  const { refineTopicFor, setRefineTopicFor, topics, selectedProjectId, refineTopicWithAnswers } = useBishopStore();
  const topic = topics.find((t) => t.id === refineTopicFor);

  const [review, setReview] = useState<TopicResearch | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [addedTasks, setAddedTasks] = useState<Task[]>([]);
  const [userActions, setUserActions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');

  const close = () => {
    setRefineTopicFor(null);
    setReview(null);
    setError(null);
    setSuccess(null);
    setReviewing(false);
    setUpdating(false);
    setAnswers({});
    setNotes('');
    setAddedTasks([]);
    setUserActions([]);
  };

  useEffect(() => {
    setAnswers({});
    setNotes('');
    setSuccess(null);
    setAddedTasks([]);
    setUserActions([]);
  }, [topic?.id]);

  const handleReview = useCallback(async () => {
    if (!topic || selectedProjectId === null || updating) return;
    setReviewing(true);
    setError(null);
    setSuccess(null);
    try {
      const answersList = review?.questions
        ? review.questions
            .map((q, i) => (answers[i]?.trim() ? `Q: ${q}\nA: ${answers[i].trim()}` : null))
            .filter((a): a is string => a !== null)
        : [];
      const res = await api.reviewTopic(selectedProjectId, topic.id, {
        title: topic.title,
        description: topic.description ?? '',
        category: topic.category,
        tasks: topic.tasks.map((t) => (t.completed ? `${t.title} (completed)` : t.title)),
        answers: answersList.length > 0 ? answersList : undefined,
        notes: notes.trim() ? notes.trim() : undefined,
      });
      setReview(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(false);
    }
  }, [topic, selectedProjectId, updating, review?.questions, answers, notes]);

  const handleUpdate = useCallback(async () => {
    if (!topic || selectedProjectId === null || reviewing || updating) return;
    setUpdating(true);
    setError(null);
    setSuccess(null);
    try {
      const answersList = review?.questions
        ? review.questions
            .map((q, i) => (answers[i]?.trim() ? `Q: ${q}\nA: ${answers[i].trim()}` : null))
            .filter((a): a is string => a !== null)
        : [];

      const res = await refineTopicWithAnswers(topic.id, {
        answers: answersList.length > 0 ? answersList : undefined,
        notes: notes.trim() ? notes.trim() : undefined,
        missing: review?.missing,
      });

      if (res) {
        setAddedTasks(res.addedTasks ?? []);
        setUserActions(res.prerequisites ?? res.userActions ?? []);
        const msg =
          res.newTasksCount > 0
            ? `Topic updated with answers! Added ${res.newTasksCount} new task${res.newTasksCount === 1 ? '' : 's'}.`
            : 'Topic updated with answers!';
        setSuccess(msg);
        setAnswers({});
        setNotes('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  }, [topic, selectedProjectId, reviewing, updating, review?.questions, review?.missing, answers, notes, refineTopicWithAnswers]);

  useEffect(() => {
    let active = true;
    if (topic && selectedProjectId !== null) {
      setReview(null);
      setError(null);
      setReviewing(true);
      api.reviewTopic(selectedProjectId, topic.id, {
        title: topic.title,
        description: topic.description ?? '',
        category: topic.category,
        tasks: topic.tasks.map((t) => (t.completed ? `${t.title} (completed)` : t.title)),
      })
        .then((res) => {
          if (active) {
            setReview(res);
            setReviewing(false);
          }
        })
        .catch((err) => {
          if (active) {
            setError(err instanceof Error ? err.message : String(err));
            setReviewing(false);
          }
        });
    }
    return () => {
      active = false;
    };
  }, [topic?.id, selectedProjectId]);

  if (!topic) return null;

  const handleAnswerChange = (index: number, val: string) => {
    setAnswers((prev) => ({ ...prev, [index]: val }));
  };

  const handleClearAnswer = (index: number) => {
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const answeredCount = review
    ? review.questions.filter((_, i) => (answers[i]?.trim() ?? '').length > 0).length
    : 0;

  const userActionList = review?.prerequisites ?? review?.userActions ?? [];

  const isUserActionTask = (task: Task) => {
    if (task.prerequisite) return true;
    const titleLower = task.title.toLowerCase();
    return (
      userActionList.some(
        (ua) => ua.toLowerCase().includes(titleLower) || titleLower.includes(ua.toLowerCase()),
      ) ||
      ['art asset', 'playtest', 'play-test', 'user testing', 'manual test', 'draw ', 'drawing', 'paint ', 'record audio', 'record voice', 'voiceover', 'voice-over', '3d model', 'sprite', 'prerequisite'].some(
        (k) => titleLower.includes(k),
      )
    );
  };

  const prerequisiteTasks = topic.tasks.filter((t) => isUserActionTask(t));
  const regularTasks = topic.tasks.filter((t) => !isUserActionTask(t));

  const unlinkedUserActions = userActionList.filter(
    (ua) => !topic.tasks.some((t) => t.title.toLowerCase().includes(ua.toLowerCase()) || ua.toLowerCase().includes(t.title.toLowerCase())),
  );

  const hasPrerequisites = prerequisiteTasks.length > 0 || unlinkedUserActions.length > 0;

  return (
    <Modal onClose={close}>
      <div data-testid="refine-topic-dialog" className="p-5 flex flex-col gap-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--primary)]" />
            <h2 className="text-base font-semibold">Refine topic</h2>
          </div>
          <button className="p-1 rounded hover:bg-[var(--card)]" title="Close" aria-label="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>

        <div>
          <h3 className="text-sm font-medium">{topic.title}</h3>
          {topic.description && (
            <p className="mt-1 text-xs text-[var(--muted-foreground)] whitespace-pre-wrap">{topic.description}</p>
          )}
        </div>

        {/* Prerequisites section: listed separately before tasks */}
        {hasPrerequisites && (
          <div data-testid="refine-prerequisites" className="flex flex-col gap-1.5 p-2.5 rounded border border-amber-500/30 bg-amber-500/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-400">
                  Prerequisites ({prerequisiteTasks.length + unlinkedUserActions.length})
                </h4>
              </div>
              <span className="text-[10px] text-[var(--muted-foreground)]">Must be done before tasks</span>
            </div>
            <p className="text-[11px] text-[var(--muted-foreground)]">
              Work requiring user action (such as creating art assets or playtesting) that must be done before the tasks can be done:
            </p>
            <ul data-testid="refine-prerequisites-list" className="flex flex-col gap-1 max-h-36 overflow-y-auto mt-0.5">
              {prerequisiteTasks.map((task) => (
                <li
                  key={task.id}
                  data-testid="refine-prerequisite-item"
                  className="text-xs text-[var(--foreground)] flex items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        task.completed ? 'bg-[var(--primary)]' : 'bg-amber-400'
                      }`}
                    />
                    <span className={`truncate ${task.completed ? 'line-through text-[var(--muted-foreground)]' : ''}`}>
                      {task.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span
                      data-testid={`task-prerequisite-${task.id}`}
                      className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/15 text-amber-400 border border-amber-500/30"
                    >
                      Prerequisite
                    </span>
                    <span data-testid={`task-user-action-${task.id}`} className="sr-only">
                      User action
                    </span>
                  </div>
                </li>
              ))}
              {unlinkedUserActions.map((action, i) => (
                <li
                  key={`ua-${i}`}
                  data-testid="refine-prerequisite-item"
                  className="text-xs text-[var(--foreground)] flex items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-400/60" />
                    <span className="truncate italic text-[var(--foreground)]">{action}</span>
                  </div>
                  <span
                    data-testid={`refine-prerequisite-action-${i}`}
                    className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/15 text-amber-400 border border-amber-500/30"
                  >
                    User action
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div data-testid="refine-tasks">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)] mb-1.5">
            Tasks ({regularTasks.length})
          </h4>
          <ul className="flex flex-col gap-1 max-h-36 overflow-y-auto">
            {regularTasks.map((task) => (
              <li key={task.id} className="text-xs text-[var(--foreground)] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <TaskComplexityDot
                    complexity={task.complexity}
                    completed={task.completed}
                    testId="refine-task-complexity"
                    className="!w-2 !h-2"
                  />
                  <span className={`truncate ${task.completed ? 'line-through text-[var(--muted-foreground)]' : ''}`}>
                    {task.title}
                  </span>
                </div>
              </li>
            ))}
            {regularTasks.length === 0 && (
              <li className="text-xs text-[var(--muted-foreground)]">
                {prerequisiteTasks.length > 0 ? 'All topic checklist items are listed as prerequisites above.' : 'No tasks yet.'}
              </li>
            )}
          </ul>
        </div>

        {reviewing && (
          <div
            data-testid="refine-reviewing"
            className="flex items-center gap-2 p-3 rounded border border-[var(--border)] bg-[var(--card)] text-xs text-[var(--muted-foreground)]"
          >
            <Loader2 size={15} className="animate-spin text-[var(--primary)] shrink-0" />
            <span>Reviewing topic for missing details…</span>
          </div>
        )}

        {error && !reviewing && (
          <div
            data-testid="refine-error"
            className="flex flex-col gap-2 p-3 rounded border border-red-500/30 bg-red-500/10 text-xs text-red-400"
          >
            <div>{error}</div>
            <button
              type="button"
              onClick={handleReview}
              className="self-start px-2 py-1 rounded bg-[var(--card)] hover:bg-[var(--sidebar)] text-[var(--foreground)] border border-[var(--border)]"
            >
              Retry review
            </button>
          </div>
        )}

        {review && !reviewing && (
          <div
            data-testid="refine-review-result"
            className="flex flex-col gap-3 p-3 rounded border border-[var(--border)] bg-[var(--card)] text-xs select-text"
          >
            <div className="flex items-center gap-1.5 font-semibold">
              {review.sufficient ? (
                <Check size={15} className="shrink-0 text-emerald-500" />
              ) : (
                <WarningCircle size={15} className="shrink-0 text-[var(--primary-text)]" />
              )}
              <span>{review.sufficient ? 'These tasks look sufficient' : 'Missing details identified'}</span>
            </div>

            {review.summary && (
              <p className="text-[var(--muted-foreground)] leading-relaxed">{review.summary}</p>
            )}

            <div data-testid="refine-missing">
              <div className="font-semibold uppercase tracking-wider text-[var(--muted-foreground)] text-[10px] mb-1">
                Missing details
              </div>
              {review.missing.length > 0 ? (
                <ul className="flex flex-col gap-1 list-disc pl-4">
                  {review.missing.map((item, i) => (
                    <li key={i} className="text-[var(--foreground)]">{item}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-[var(--muted-foreground)]">No missing tasks identified.</p>
              )}
            </div>

            {/* Prerequisites / Work requiring user action section */}
            <div data-testid="refine-user-actions" className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border)]">
              <div className="flex items-center justify-between">
                <div className="font-semibold uppercase tracking-wider text-[var(--muted-foreground)] text-[10px]">
                  Prerequisites (user actions)
                </div>
                {userActionList.length > 0 && (
                  <span className="text-[10px] text-amber-400 font-medium">
                    {userActionList.length} {userActionList.length === 1 ? 'prerequisite' : 'prerequisites'}
                  </span>
                )}
              </div>
              {userActionList.length > 0 ? (
                <>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Work requiring user action (such as creating art assets or playtesting), listed separately as prerequisites that must be done before the tasks can be done:
                  </p>
                  <ul className="flex flex-col gap-1 list-disc pl-4" data-testid="refine-prerequisites-review-list">
                    {userActionList.map((action, i) => (
                      <li key={i} data-testid={`refine-user-action-${i}`} className="text-[var(--foreground)]">
                        <span data-testid={`refine-prerequisite-${i}`}>{action}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-[var(--muted-foreground)]">
                  No work requiring user action identified.
                </p>
              )}
            </div>

            {/* Clarifying questions section */}
            <div data-testid="refine-questions" className="flex flex-col gap-2 pt-2 border-t border-[var(--border)]">
              <div className="flex items-center justify-between">
                <div className="font-semibold uppercase tracking-wider text-[var(--muted-foreground)] text-[10px]">
                  Clarifying questions
                </div>
                {review.questions.length > 0 && (
                  <span className="text-[10px] text-[var(--muted-foreground)]">
                    {answeredCount > 0
                      ? `${answeredCount} of ${review.questions.length} answered`
                      : `${review.questions.length} ${review.questions.length === 1 ? 'question' : 'questions'}`}
                  </span>
                )}
              </div>

              {review.questions.length > 0 ? (
                <div className="flex flex-col gap-2.5">
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Answer these clarifying questions to help fill in what is missing:
                  </p>
                  <div className="flex flex-col gap-2">
                    {review.questions.map((q, i) => {
                      const isAnswered = (answers[i]?.trim().length ?? 0) > 0;
                      return (
                        <div
                          key={i}
                          data-testid={`refine-question-${i}`}
                          className="flex flex-col gap-1.5 p-2 rounded bg-[var(--sidebar)] border border-[var(--border)]"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <label
                              htmlFor={`refine-answer-${i}`}
                              className="text-xs font-medium text-[var(--foreground)] leading-snug cursor-text"
                            >
                              <span className="text-[var(--primary-text)] font-semibold mr-1.5">{i + 1}.</span>
                              {q}
                            </label>
                            {isAnswered && (
                              <span className="shrink-0 flex items-center gap-1 text-[10px] text-emerald-500 font-medium">
                                <Check size={11} />
                                Answered
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <textarea
                              id={`refine-answer-${i}`}
                              data-testid={`refine-question-input-${i}`}
                              rows={2}
                              aria-label={`Answer to: ${q}`}
                              placeholder="Your answer…"
                              value={answers[i] ?? ''}
                              onChange={(e) => handleAnswerChange(i, e.target.value)}
                              className="w-full px-2 py-1 text-xs rounded bg-[var(--card)] border border-[var(--border)] outline-none focus:border-[var(--primary)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] resize-y min-h-[2rem]"
                            />
                            {isAnswered && (
                              <button
                                type="button"
                                title="Clear answer"
                                aria-label="Clear answer"
                                onClick={() => handleClearAnswer(i)}
                                className="p-1 rounded text-[var(--muted-foreground)] hover:text-red-400 shrink-0 self-start"
                              >
                                <X size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[var(--muted-foreground)] italic">
                  No clarifying questions needed for this topic.
                </p>
              )}

              {/* Optional additional notes or user clarifications */}
              <div data-testid="refine-additional-notes" className="flex flex-col gap-1 mt-1">
                <label
                  htmlFor="refine-additional-clarifications"
                  className="font-semibold uppercase tracking-wider text-[var(--muted-foreground)] text-[10px]"
                >
                  Additional notes or instructions (optional)
                </label>
                <textarea
                  id="refine-additional-clarifications"
                  data-testid="refine-notes-input"
                  rows={2}
                  aria-label="Additional notes or instructions"
                  placeholder="Add any extra details or instructions…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full px-2 py-1 text-xs rounded bg-[var(--card)] border border-[var(--border)] outline-none focus:border-[var(--primary)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] resize-y min-h-[2rem]"
                />
              </div>
            </div>
          </div>
        )}

        {updating && (
          <div
            data-testid="refine-updating"
            className="flex items-center gap-2 p-3 rounded border border-[var(--border)] bg-[var(--card)] text-xs text-[var(--muted-foreground)]"
          >
            <Loader2 size={15} className="animate-spin text-[var(--primary)] shrink-0" />
            <span>Updating topic with answers…</span>
          </div>
        )}

        {success && !updating && (
          <div
            data-testid="refine-success"
            className="flex flex-col gap-2 p-3 rounded border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-400"
          >
            <div className="flex items-center gap-1.5 font-medium">
              <Check size={14} className="shrink-0 text-emerald-500" />
              <span>{success}</span>
            </div>
            {addedTasks.length > 0 && (
              <div data-testid="refine-added-tasks" className="mt-1 pl-5">
                <span className="text-[10px] uppercase font-semibold text-[var(--muted-foreground)] tracking-wider">
                  New tasks added:
                </span>
                <ul className="list-disc pl-4 mt-1 flex flex-col gap-0.5 text-xs text-[var(--foreground)]">
                  {addedTasks.map((t) => (
                    <li key={t.id}>{t.title}</li>
                  ))}
                </ul>
              </div>
            )}
            {userActions.length > 0 && (
              <div data-testid="refine-identified-user-actions" className="mt-1 pl-5">
                <span className="text-[10px] uppercase font-semibold text-[var(--muted-foreground)] tracking-wider">
                  Prerequisites (user actions):
                </span>
                <p className="text-[11px] text-[var(--muted-foreground)] mt-0.5">
                  Must be done before the tasks can be done:
                </p>
                <ul className="list-disc pl-4 mt-1 flex flex-col gap-0.5 text-xs text-[var(--foreground)]" data-testid="refine-identified-prerequisites">
                  {userActions.map((action, i) => (
                    <li key={i} data-testid={`refine-prerequisite-result-${i}`}>{action}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-[var(--border)] pt-3">
          <button
            data-testid="refine-review-btn"
            type="button"
            disabled={reviewing || updating}
            onClick={handleReview}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-[var(--card)] hover:bg-[var(--sidebar)] text-[var(--foreground)] border border-[var(--border)] disabled:opacity-50"
          >
            {reviewing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            <span>{review ? 'Review again' : 'Review topic'}</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-xs rounded bg-[var(--card)] hover:bg-[var(--sidebar)] text-[var(--foreground)] border border-[var(--border)]"
              onClick={close}
            >
              {success ? 'Done' : 'Close'}
            </button>
            <button
              data-testid="refine-update-topic-btn"
              type="button"
              disabled={reviewing || updating || !review}
              onClick={handleUpdate}
              title="Update the topic with the answers"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)] disabled:opacity-50"
            >
              {updating && <Loader2 size={13} className="animate-spin" />}
              <span>{updating ? 'Updating topic…' : 'Update topic'}</span>
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
