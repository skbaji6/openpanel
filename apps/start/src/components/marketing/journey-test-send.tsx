import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import { testSendIdProblem, testSendIsPending } from './campaign-launch';
import type { JourneyTestSendsResponse, Rule } from './contract';
import { JOURNEY_TEST_SEND_POLL_MS } from './polling';
import { labelTestSendReason, labelTestSendStatus } from './reason-labels';
import { DEFAULT_VARIANT, variantKeys } from './step-variants';
import { NOT_ADMIN_NOTE, useMarketingRole } from './use-marketing-role';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const tabLabel = (variant: string) =>
  variant === DEFAULT_VARIANT ? 'Default' : variant;

export function JourneyTestSend({ rule }: { rule: Rule }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const { isAdmin } = useMarketingRole();
  const stepId = useId();
  const variantId = useId();
  const { steps } = rule.definition;
  const [stepIndex, setStepIndex] = useState(0);
  const [variant, setVariant] = useState('');
  const [studentId, setStudentId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const path = `rules/${encodeURIComponent(rule.id)}/test-sends`;
  const listKey = queryKey('rules', rule.id, 'test-sends');
  const refresh = () => client.invalidateQueries({ queryKey: listKey });

  const sends = useQuery({
    queryKey: listKey,
    queryFn: () => marketingFetch<JourneyTestSendsResponse>(path),
    refetchInterval: (query) =>
      testSendIsPending(query.state.data?.testSends ?? [])
        ? JOURNEY_TEST_SEND_POLL_MS
        : false,
  });

  const index = Math.min(stepIndex, steps.length - 1);
  const step = steps[index];
  const variants = step ? variantKeys(step) : [];
  const chosenVariant = variants.includes(variant)
    ? variant
    : (variants[0] ?? DEFAULT_VARIANT);

  const send = useMutation({
    mutationFn: (profileId: string) =>
      marketingFetch<{ id: string }>(
        `rules/${encodeURIComponent(rule.id)}/test-send`,
        {
          method: 'POST',
          body: JSON.stringify({
            profileId,
            stepIndex: index,
            variant: chosenVariant,
          }),
        }
      ),
    onSuccess() {
      toast.success('Test queued');
      setStudentId('');
    },
    onError: (error) => toast.error(describeMarketingError(error)),
    // A timeout can hide a request that was queued, so the list reloads after any outcome.
    onSettled: refresh,
  });

  return (
    <section aria-label="Send a test" className="card col gap-3 p-4">
      <h3 className="font-medium">Send a test</h3>
      <p className="text-muted-foreground text-xs">
        Sends one step and state message, as saved, to one student. Quiet hours
        do not apply. Save your edits first.
      </p>
      <fieldset className="col gap-3" disabled={!isAdmin}>
        <div className="grid gap-3 md:grid-cols-2">
          <WithLabel id={stepId} label="Step">
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              id={stepId}
              onChange={(event) => setStepIndex(Number(event.target.value))}
              value={index}
            >
              {steps.map((candidate, index) => (
                <option
                  key={`${candidate.delaySeconds}-${candidate.channel}`}
                  value={index}
                >
                  {`Step ${index + 1} (${candidate.channel})`}
                </option>
              ))}
            </select>
          </WithLabel>
          <WithLabel
            hint="The message of this state is sent, whatever the student's own state is."
            id={variantId}
            label="State message"
          >
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              id={variantId}
              onChange={(event) => setVariant(event.target.value)}
              value={chosenVariant}
            >
              {variants.map((key) => (
                <option key={key} value={key}>
                  {tabLabel(key)}
                </option>
              ))}
            </select>
          </WithLabel>
        </div>
        <form
          className="col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const found = testSendIdProblem(studentId);
            setProblem(found);
            if (!(found || send.isPending)) {
              send.mutate(studentId.trim());
            }
          }}
        >
          <InputWithLabel
            autoComplete="off"
            error={problem ?? undefined}
            hint="The id of a student in your audience API, not a phone number or email."
            label="Student id"
            onChange={(event) => setStudentId(event.target.value)}
            value={studentId}
          />
          <p className="font-medium text-amber-600 text-sm">
            This sends a real message to that student.
          </p>
          <div>
            <Button loading={send.isPending} type="submit" variant="outline">
              Send test
            </Button>
          </div>
        </form>
      </fieldset>
      {!isAdmin && (
        <p className="text-muted-foreground text-xs">{NOT_ADMIN_NOTE}</p>
      )}
      {sends.error && (
        <p className="text-destructive text-sm">
          {describeMarketingError(sends.error)}
        </p>
      )}
      {sends.data && sends.data.testSends.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Step</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Student id</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Requested</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sends.data.testSends.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.stepIndex + 1}</TableCell>
                <TableCell>{tabLabel(row.variant)}</TableCell>
                <TableCell>{row.profileId}</TableCell>
                <TableCell>{labelTestSendStatus(row.status)}</TableCell>
                <TableCell>
                  {row.reason ? labelTestSendReason(row.reason) : ''}
                </TableCell>
                <TableCell>
                  {new Date(row.createdAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
