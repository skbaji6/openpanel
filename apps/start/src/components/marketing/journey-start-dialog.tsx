import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { TemplateRow } from './campaign-contract';
import type { JourneyField, Rule, StartResponse } from './contract';
import {
  describeStart,
  labelStartWarning,
  startErrorMessage,
} from './journey-start';
import { NOT_ADMIN_NOTE, useMarketingRole } from './use-marketing-role';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const FIELD_NAMES: Record<JourneyField, string> = {
  trigger: 'Trigger event',
  goal: 'Goal event',
};

function eventOf(rule: Rule, field: JourneyField): string {
  const { definition } = rule;
  if (field === 'trigger') {
    return definition.trigger.event;
  }
  return definition.goal.kind === 'inactivity'
    ? 'the profile stays inactive'
    : definition.goal.event;
}

export function JourneyStartDialog({
  rule,
  onClose,
  onEdit,
}: {
  rule: Rule;
  onClose: () => void;
  onEdit: () => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const { isAdmin } = useMarketingRole();
  const templates = useQuery({
    queryKey: queryKey('templates', 'all'),
    queryFn: () => marketingFetch<{ templates: TemplateRow[] }>('templates'),
  });
  const refreshRules = () =>
    client.invalidateQueries({ queryKey: queryKey('rules') });
  const replaceRule = (next: Rule | null) => {
    if (!next) {
      return;
    }
    client.setQueryData<{ rules: Rule[] }>(queryKey('rules'), (current) =>
      current
        ? {
            rules: current.rules.map((row) =>
              row.id === next.id ? next : row
            ),
          }
        : current
    );
  };
  const path = `rules/${encodeURIComponent(rule.id)}`;
  const unconfirmed = rule.unconfirmed ?? [];

  const confirm = useMutation({
    mutationFn: () =>
      marketingFetch<Rule>(path, {
        method: 'PATCH',
        body: JSON.stringify({ confirmed: unconfirmed }),
      }),
    onSuccess(next) {
      replaceRule(next);
      toast.success('Events confirmed');
    },
    onError: (error) => toast.error(describeMarketingError(error)),
    onSettled: refreshRules,
  });
  const start = useMutation({
    // The version of the row on screen: a journey that changed since is refused, not started.
    mutationFn: () =>
      marketingFetch<StartResponse>(`${path}/start`, {
        method: 'POST',
        body: JSON.stringify({ expectedVersion: rule.version }),
      }),
    onSuccess(response) {
      replaceRule(response.rule);
      toast.success('Journey started');
      onClose();
    },
    onError: (error) => toast.error(startErrorMessage(error)),
    // A timeout can hide a start that went through, so the list is always reloaded.
    onSettled: refreshRules,
  });

  const view = describeStart(rule, templates.data?.templates ?? []);
  const isDraft = rule.status === 'draft';
  const needsConfirm = unconfirmed.length > 0;
  const startWarnings = view.warnings.filter(
    (warning) => !warning.startsWith('unconfirmed')
  );

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Start {rule.name}?</DialogTitle>
          <DialogDescription>
            Starting pins the template versions below and begins messaging
            students who match.
          </DialogDescription>
        </DialogHeader>
        {!isDraft && (
          <p className="text-sm" role="status">
            This journey is already {rule.status}. Close this and check its
            card.
          </p>
        )}
        {isDraft && needsConfirm && (
          <section
            aria-label="Guessed events"
            className="col gap-2 rounded-md border border-amber-500 bg-amber-500/10 p-3"
          >
            <h3 className="font-medium text-sm">
              Check these events before starting
            </h3>
            <p className="text-sm">
              The import guessed these event names. If they are wrong, no
              student will ever enter or finish the journey.
            </p>
            <ul className="col gap-1 text-sm">
              {unconfirmed.map((field) => (
                <li key={field}>
                  {FIELD_NAMES[field]}: <strong>{eventOf(rule, field)}</strong>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              To change a name, use Edit journey. Saving an edited event
              confirms it.
            </p>
            <div className="row gap-2">
              <Button
                disabled={!isAdmin}
                loading={confirm.isPending}
                onClick={() => confirm.mutate()}
                title={isAdmin ? undefined : NOT_ADMIN_NOTE}
                variant="outline"
              >
                These are correct
              </Button>
              <Button
                disabled={!isAdmin}
                onClick={onEdit}
                title={isAdmin ? undefined : NOT_ADMIN_NOTE}
                variant="ghost"
              >
                Edit journey
              </Button>
            </div>
          </section>
        )}
        <section aria-label="What will happen" className="col gap-2 text-sm">
          <p>
            Reacts to <strong>{view.reactsTo}</strong>
            {view.filters.length > 0 && <> where {view.filters.join(', ')}</>},
            until <strong>{view.goal}</strong>.
          </p>
          <ol className="col gap-1">
            {view.steps.map((step, index) => (
              <li
                // Steps have no ids; their position is their identity.
                key={`${index}-${step.delay}`}
              >
                Step {index + 1}, {step.delay}, {step.channel}
                {step.variants.length > 0 &&
                  `, states: ${step.variants.join(', ')}`}
                {step.hasDefault ? ', with a default message' : ''}
                {step.template ? `, template ${step.template}` : ''}
              </li>
            ))}
          </ol>
        </section>
        {startWarnings.length > 0 && (
          <ul className="col gap-1 text-sm" role="alert">
            {startWarnings.map((warning) => (
              <li key={warning}>{labelStartWarning(warning)}</li>
            ))}
          </ul>
        )}
        <DialogFooter className="items-center">
          {!isAdmin && (
            <span className="text-muted-foreground text-xs">
              {NOT_ADMIN_NOTE}
            </span>
          )}
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
          {isDraft && !needsConfirm && (
            <Button
              disabled={!isAdmin}
              loading={start.isPending}
              onClick={() => start.mutate()}
              title={isAdmin ? undefined : NOT_ADMIN_NOTE}
            >
              Start journey
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
