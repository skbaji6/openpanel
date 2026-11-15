import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, PlusIcon, WorkflowIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type {
  JourneySkipsResponse,
  Rule,
  RuleDefinition,
  RuleStatus,
  StarterRule,
} from './contract';
import { JourneyImportDialog } from './journey-import-dialog';
import { describeGoal } from './journey-start';
import { JourneyStartDialog } from './journey-start-dialog';
import { labelRecipientReason } from './reason-labels';
import { emptyRuleDefinition, RuleEditor } from './rule-editor';
import { NOT_ADMIN_NOTE, useMarketingRole } from './use-marketing-role';
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

function JourneySkips({ ruleId }: { ruleId: string }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const skips = useQuery({
    queryKey: queryKey('rules', ruleId, 'skips'),
    queryFn: () =>
      marketingFetch<JourneySkipsResponse>(
        `rules/${encodeURIComponent(ruleId)}/skips`
      ),
  });
  const reasons = skips.data?.reasons ?? [];
  if (reasons.length === 0) {
    return null;
  }
  return (
    <section aria-label="Skipped messages" className="px-4 pb-4 text-sm">
      <h3 className="font-medium">Skipped messages</h3>
      <ul className="list-disc pl-5">
        {reasons.map(({ reason, count }) => (
          <li key={reason}>
            {labelRecipientReason(reason)}: {count}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RuleCard({
  rule,
  onEdit,
  onStart,
}: {
  rule: Rule;
  onEdit: () => void;
  onStart: () => void;
}) {
  const { isAdmin } = useMarketingRole();
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const refresh = () =>
    client.invalidateQueries({ queryKey: queryKey('rules') });
  const path = `rules/${encodeURIComponent(rule.id)}`;
  const setStatus = useMutation({
    mutationFn: (status: RuleStatus) =>
      marketingFetch(path, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: refresh,
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  const remove = useMutation({
    mutationFn: () => marketingFetch(path, { method: 'DELETE' }),
    onSuccess() {
      toast.success('Rule deleted');
      refresh();
    },
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  const isActive = rule.status === 'active';
  const isDraft = rule.status === 'draft';
  const unconfirmed = rule.unconfirmed ?? [];
  const statusVariant = isDraft ? 'warning' : 'secondary';
  return (
    <article aria-label={rule.name} className="card">
      <IntegrationCardHeader>
        <div className="row items-center gap-2">
          <h2 className="title">{rule.name}</h2>
          <Badge variant={isActive ? 'success' : statusVariant}>
            {isDraft ? 'Draft' : rule.status}
          </Badge>
        </div>
      </IntegrationCardHeader>
      <p className="p-4 text-sm">
        When <strong>{rule.definition.trigger.event}</strong> happens, send{' '}
        {rule.definition.steps.length} message
        {rule.definition.steps.length === 1 ? '' : 's'} until{' '}
        <strong>{describeGoal(rule.definition)}</strong>.
      </p>
      {rule.journeyKey && (
        <p className="px-4 pb-2 text-muted-foreground text-xs">
          Imported journey: {rule.journeyKey}
        </p>
      )}
      {unconfirmed.length > 0 && (
        <p className="px-4 pb-2 font-medium text-amber-600 text-sm">
          Guessed {unconfirmed.join(' and ')} event. Confirm it before starting.
        </p>
      )}
      {rule.journeyKey && <JourneySkips ruleId={rule.id} />}
      <IntegrationCardFooter className="row justify-end gap-2">
        <Button
          className="text-destructive"
          onClick={() =>
            showConfirm({
              title: `Delete ${rule.name}?`,
              text: 'Pending messages of this rule are cancelled. This cannot be undone.',
              onConfirm: () => remove.mutate(),
            })
          }
          variant="ghost"
        >
          Delete
        </Button>
        {isDraft ? (
          <Button
            disabled={!isAdmin}
            onClick={onStart}
            title={isAdmin ? undefined : NOT_ADMIN_NOTE}
            variant="ghost"
          >
            Start
          </Button>
        ) : (
          <Button
            loading={setStatus.isPending}
            onClick={() => setStatus.mutate(isActive ? 'paused' : 'active')}
            variant="ghost"
          >
            {isActive ? 'Pause' : 'Activate'}
          </Button>
        )}
        <Button onClick={onEdit} variant="ghost">
          Edit
        </Button>
      </IntegrationCardFooter>
    </article>
  );
}

export function RulesPage() {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const { isAdmin } = useMarketingRole();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const rules = useQuery({
    queryKey: queryKey('rules'),
    queryFn: () => marketingFetch<{ rules: Rule[] }>('rules'),
  });
  const starters = useQuery({
    queryKey: queryKey('starter-rules'),
    queryFn: () =>
      marketingFetch<{ starterRules: StarterRule[] }>('starter-rules'),
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (draft) {
    return (
      <RuleEditor
        initial={draft.definition}
        onClose={() => setDraft(null)}
        rule={rules.data?.rules.find((row) => row.id === draft.ruleId)}
        ruleId={draft.ruleId}
      />
    );
  }

  const startingRule = rules.data?.rules.find(
    (candidate) => candidate.id === startingId
  );
  const actions = (
    <div className="row items-center gap-2">
      {!isAdmin && (
        <span className="text-muted-foreground text-xs">{NOT_ADMIN_NOTE}</span>
      )}
      <Button
        disabled={!isAdmin}
        onClick={() => setImporting(true)}
        title={isAdmin ? undefined : NOT_ADMIN_NOTE}
        variant="outline"
      >
        Import journeys
      </Button>
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
        description={describeMarketingError(rules.error)}
        icon={WorkflowIcon}
        title="Journeys are not available"
      />
    );
  }
  if (rules.data.rules.length === 0) {
    return (
      <FullPageEmptyState
        description="A rule watches for an event, waits, and messages the profile until it reaches the goal. New here? Pick a template to start, or open the How it works tab."
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
            onStart={() => setStartingId(rule.id)}
            rule={rule}
          />
        ))}
      </div>
      {importing && <JourneyImportDialog onClose={() => setImporting(false)} />}
      {startingRule && (
        <JourneyStartDialog
          onClose={() => setStartingId(null)}
          onEdit={() => {
            setStartingId(null);
            setDraft({
              ruleId: startingRule.id,
              definition: structuredClone(startingRule.definition),
            });
          }}
          rule={startingRule}
        />
      )}
    </div>
  );
}
