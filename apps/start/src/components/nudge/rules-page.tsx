import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, PlusIcon, WorkflowIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { describeNudgeError, useNudgeFetch, useNudgeQueryKey } from './api';
import type { Rule, RuleDefinition, RuleStatus, StarterRule } from './contract';
import { emptyRuleDefinition, RuleEditor } from './rule-editor';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import {
  IntegrationCardFooter,
  IntegrationCardHeader,
} from '@/components/integrations/integration-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { showConfirm } from '@/modals';

interface Draft {
  ruleId?: string;
  definition: RuleDefinition;
}

function describeGoal(definition: RuleDefinition): string {
  const { goal } = definition;
  if (goal.kind === 'inactivity') {
    return 'the profile stays inactive';
  }
  if (goal.kind === 'set') {
    return `${goal.event} covers every ${goal.property}`;
  }
  return goal.event;
}

function RuleCard({ rule, onEdit }: { rule: Rule; onEdit: () => void }) {
  const nudgeFetch = useNudgeFetch();
  const queryKey = useNudgeQueryKey();
  const client = useQueryClient();
  const refresh = () =>
    client.invalidateQueries({ queryKey: queryKey('rules') });
  const path = `rules/${encodeURIComponent(rule.id)}`;
  const setStatus = useMutation({
    mutationFn: (status: RuleStatus) =>
      nudgeFetch(path, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: refresh,
    onError: (error) => toast.error(describeNudgeError(error)),
  });
  const remove = useMutation({
    mutationFn: () => nudgeFetch(path, { method: 'DELETE' }),
    onSuccess() {
      toast.success('Rule deleted');
      refresh();
    },
    onError: (error) => toast.error(describeNudgeError(error)),
  });
  const isActive = rule.status === 'active';
  return (
    <article aria-label={rule.name} className="card">
      <IntegrationCardHeader>
        <div className="row items-center gap-2">
          <h2 className="title">{rule.name}</h2>
          <Badge variant={isActive ? 'success' : 'secondary'}>
            {rule.status}
          </Badge>
        </div>
      </IntegrationCardHeader>
      <p className="p-4 text-sm">
        When <strong>{rule.definition.trigger.event}</strong> happens, send{' '}
        {rule.definition.steps.length} nudge
        {rule.definition.steps.length === 1 ? '' : 's'} until{' '}
        <strong>{describeGoal(rule.definition)}</strong>.
      </p>
      <IntegrationCardFooter className="row justify-end gap-2">
        <Button
          className="text-destructive"
          onClick={() =>
            showConfirm({
              title: `Delete ${rule.name}?`,
              text: 'Pending nudges of this rule are cancelled. This cannot be undone.',
              onConfirm: () => remove.mutate(),
            })
          }
          variant="ghost"
        >
          Delete
        </Button>
        <Button
          loading={setStatus.isPending}
          onClick={() => setStatus.mutate(isActive ? 'paused' : 'active')}
          variant="ghost"
        >
          {isActive ? 'Pause' : 'Activate'}
        </Button>
        <Button onClick={onEdit} variant="ghost">
          Edit
        </Button>
      </IntegrationCardFooter>
    </article>
  );
}

export function RulesPage() {
  const nudgeFetch = useNudgeFetch();
  const queryKey = useNudgeQueryKey();
  const [draft, setDraft] = useState<Draft | null>(null);
  const rules = useQuery({
    queryKey: queryKey('rules'),
    queryFn: () => nudgeFetch<{ rules: Rule[] }>('rules'),
  });
  const starters = useQuery({
    queryKey: queryKey('starter-rules'),
    queryFn: () => nudgeFetch<{ starterRules: StarterRule[] }>('starter-rules'),
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (draft) {
    return (
      <RuleEditor
        initial={draft.definition}
        onClose={() => setDraft(null)}
        ruleId={draft.ruleId}
      />
    );
  }

  const actions = (
    <div className="row gap-2">
      <DropdownMenuComposed
        items={(starters.data?.starterRules ?? []).map((starter) => ({
          value: starter.key,
          label: starter.definition.name,
        }))}
        label="Templates"
        onChange={(key) => {
          const starter = starters.data?.starterRules.find(
            (candidate) => candidate.key === key
          );
          if (starter) {
            setDraft({ definition: structuredClone(starter.definition) });
          }
        }}
      >
        <Button variant="outline">
          Start from template
          <ChevronDownIcon className="ml-2 size-4" />
        </Button>
      </DropdownMenuComposed>
      <Button
        icon={PlusIcon}
        onClick={() => setDraft({ definition: emptyRuleDefinition() })}
      >
        Add rule
      </Button>
    </div>
  );

  if (rules.isPending) {
    return <FullPageLoadingState />;
  }
  if (rules.error) {
    return (
      <FullPageEmptyState
        description={describeNudgeError(rules.error)}
        icon={WorkflowIcon}
        title="Nudges are not available"
      />
    );
  }
  if (rules.data.rules.length === 0) {
    return (
      <FullPageEmptyState
        description="A rule watches for an event, waits, and nudges the profile until it reaches the goal. New here? Pick a template to start, or open the How it works tab."
        icon={WorkflowIcon}
        title="No rules yet"
      >
        {actions}
      </FullPageEmptyState>
    );
  }
  return (
    <div className="col gap-4">
      <div className="row justify-end">{actions}</div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {rules.data.rules.map((rule) => (
          <RuleCard
            key={rule.id}
            onEdit={() =>
              setDraft({
                ruleId: rule.id,
                definition: structuredClone(rule.definition),
              })
            }
            rule={rule}
          />
        ))}
      </div>
    </div>
  );
}
