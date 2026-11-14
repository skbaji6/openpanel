import { useQuery } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { useState } from 'react';
import { useMarketingFetch, useMarketingQueryKey } from './api';
import {
  canNest,
  coerceValue,
  emptyCondition,
  emptyGroup,
  type FilterPath,
  isMultiValue,
  OP_LABELS,
  opsFor,
  removeNode,
  updateNode,
} from './audience-filter';
import type {
  Condition,
  Dimension,
  DimensionValue,
  FilterGroup,
  FilterTree,
} from './campaign-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDebounceValue } from '@/hooks/use-debounce-value';

const SEARCH_DEBOUNCE_MS = 300;
const SELECT_CLASS = 'h-8 rounded-md border bg-background px-2 text-sm';

type FilterValue = Condition['values'][number];

interface BuilderContext {
  root: FilterGroup;
  dimensions: Dimension[];
  idPrefix: string;
  change: (path: FilterPath, update: (node: FilterTree) => FilterTree) => void;
  remove: (path: FilterPath) => void;
}

function inputTypeFor(dimension: Dimension): string {
  if (dimension.type === 'number') {
    return 'number';
  }
  return dimension.type === 'date' ? 'date' : 'text';
}

function ValueChips({
  values,
  onRemove,
}: {
  values: FilterValue[];
  onRemove: (index: number) => void;
}) {
  return (
    <ul className="row flex-wrap gap-1">
      {values.map((value, index) => (
        <li
          className="row items-center gap-1 rounded border px-2 py-0.5 text-xs"
          key={String(value)}
        >
          {String(value)}
          <button
            aria-label={`Remove ${String(value)}`}
            onClick={() => onRemove(index)}
            type="button"
          >
            <XIcon size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ValuePicker({
  dimension,
  id,
  onPick,
}: {
  dimension: Dimension;
  id: string;
  onPick: (value: string) => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const query = useDebounceValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const values = useQuery({
    queryKey: queryKey('audience-values', dimension.key, query),
    queryFn: () =>
      marketingFetch<{ values: DimensionValue[] }>(
        `audience/dimensions/${encodeURIComponent(dimension.key)}/values?q=${encodeURIComponent(query)}`
      ),
    enabled: open,
  });
  return (
    <div className="col gap-1">
      <Input
        aria-label={`Search ${dimension.label} values`}
        id={id}
        onChange={(event) => setSearch(event.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="Search values"
        value={search}
      />
      {values.error && (
        <p className="text-destructive text-xs">Values could not be loaded</p>
      )}
      {open && values.data && (
        <div className="row flex-wrap gap-1">
          {values.data.values.length === 0 && (
            <span className="text-muted-foreground text-xs">No matches</span>
          )}
          {values.data.values.map((item) => (
            <Button
              key={item.value}
              onClick={() => onPick(item.value)}
              size="sm"
              type="button"
              variant="outline"
            >
              {item.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function FreeValueInput({
  dimension,
  id,
  onAdd,
}: {
  dimension: Dimension;
  id: string;
  onAdd: (raw: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    if (draft.trim() === '') {
      return;
    }
    onAdd(draft.trim());
    setDraft('');
  };
  return (
    <div className="row gap-1">
      <Input
        aria-label={`Add a ${dimension.label} value`}
        id={id}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            add();
          }
        }}
        type={inputTypeFor(dimension)}
        value={draft}
      />
      <Button onClick={add} size="sm" type="button" variant="outline">
        Add
      </Button>
    </div>
  );
}

function ValuesEditor({
  condition,
  dimension,
  id,
  onChange,
}: {
  condition: Condition;
  dimension: Dimension;
  id: string;
  onChange: (values: FilterValue[]) => void;
}) {
  const { op, values } = condition;
  if (op === 'exists') {
    return null;
  }
  if (isMultiValue(op)) {
    const add = (raw: string) => {
      const value = coerceValue(dimension, raw);
      if (!values.includes(value)) {
        onChange([...values, value]);
      }
    };
    return (
      <div className="col gap-1">
        <ValueChips
          onRemove={(index) => onChange(values.filter((_, i) => i !== index))}
          values={values}
        />
        {dimension.valuesListable ? (
          <ValuePicker dimension={dimension} id={id} onPick={add} />
        ) : (
          <FreeValueInput dimension={dimension} id={id} onAdd={add} />
        )}
      </div>
    );
  }
  if (dimension.type === 'boolean') {
    return (
      <select
        aria-label={`${dimension.label} value`}
        className={SELECT_CLASS}
        id={id}
        onChange={(event) =>
          onChange(
            event.target.value === ''
              ? []
              : [coerceValue(dimension, event.target.value)]
          )
        }
        value={values.length > 0 ? String(values[0]) : ''}
      >
        <option value="">Choose</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  const slots = op === 'between' ? [0, 1] : [0];
  const setSlot = (slot: number, raw: string) => {
    const next = slots.map((index) =>
      index === slot ? coerceValue(dimension, raw) : (values[index] ?? '')
    );
    onChange(next.every((value) => value === '') ? [] : next);
  };
  return (
    <div className="row items-center gap-1">
      {slots.map((slot) => (
        <Input
          aria-label={
            slots.length > 1
              ? `${dimension.label} ${slot === 0 ? 'from' : 'to'}`
              : `${dimension.label} value`
          }
          id={slot === 0 ? id : `${id}-to`}
          key={slot}
          onChange={(event) => setSlot(slot, event.target.value)}
          type={inputTypeFor(dimension)}
          value={String(values[slot] ?? '')}
        />
      ))}
    </div>
  );
}

function ConditionRow({
  condition,
  path,
  context,
}: {
  condition: Condition;
  path: FilterPath;
  context: BuilderContext;
}) {
  const { dimensions, idPrefix, change, remove } = context;
  const dimension = dimensions.find((d) => d.key === condition.dimension);
  const baseId = `${idPrefix}-${path.join('-')}`;
  const setCondition = (next: Condition) => change(path, () => next);
  return (
    <div className="row flex-wrap items-start gap-2 rounded border p-2">
      <select
        aria-label="Field"
        className={SELECT_CLASS}
        id={`${baseId}-field`}
        onChange={(event) => {
          const picked = dimensions.find((d) => d.key === event.target.value);
          if (picked) {
            setCondition(emptyCondition(picked));
          }
        }}
        value={dimension ? dimension.key : ''}
      >
        {!dimension && <option value="">Unknown field</option>}
        {dimensions.map((d) => (
          <option key={d.key} value={d.key}>
            {d.label}
          </option>
        ))}
      </select>
      {dimension && (
        <select
          aria-label="Operator"
          className={SELECT_CLASS}
          id={`${baseId}-op`}
          onChange={(event) => {
            const op = opsFor(dimension).find(
              (option) => option === event.target.value
            );
            if (op) {
              setCondition({ ...condition, op, values: [] });
            }
          }}
          value={condition.op}
        >
          {opsFor(dimension).map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
        </select>
      )}
      {dimension && (
        <ValuesEditor
          condition={condition}
          dimension={dimension}
          id={`${baseId}-value`}
          onChange={(values) => setCondition({ ...condition, values })}
        />
      )}
      <Button
        aria-label="Remove condition"
        className="ml-auto"
        icon={XIcon}
        onClick={() => remove(path)}
        size="icon"
        type="button"
        variant="ghost"
      />
    </div>
  );
}

function GroupEditor({
  group,
  path,
  context,
}: {
  group: FilterGroup;
  path: FilterPath;
  context: BuilderContext;
}) {
  const { root, dimensions, idPrefix, change, remove } = context;
  const isRoot = path.length === 0;
  const firstDimension = dimensions[0];
  const append = (child: FilterTree) =>
    change(path, (node) =>
      'children' in node
        ? { ...node, children: [...node.children, child] }
        : node
    );
  return (
    <div
      className={
        isRoot ? 'col gap-2' : 'col gap-2 rounded border border-dashed p-2'
      }
    >
      {group.children.length > 1 && (
        <select
          aria-label="How the conditions combine"
          className={`${SELECT_CLASS} self-start`}
          id={`${idPrefix}-${path.join('-')}-combine`}
          onChange={(event) =>
            change(path, (node) =>
              'children' in node
                ? { ...node, op: event.target.value === 'or' ? 'or' : 'and' }
                : node
            )
          }
          value={group.op}
        >
          <option value="and">Match all of these</option>
          <option value="or">Match any of these</option>
        </select>
      )}
      {group.children.map((child, index) => {
        const childPath = [...path, index];
        return 'children' in child ? (
          <GroupEditor
            context={context}
            group={child}
            key={childPath.join('-')}
            path={childPath}
          />
        ) : (
          <ConditionRow
            condition={child}
            context={context}
            key={childPath.join('-')}
            path={childPath}
          />
        );
      })}
      <div className="row gap-2">
        {firstDimension && (
          <Button
            onClick={() => append(emptyCondition(firstDimension))}
            size="sm"
            type="button"
            variant="outline"
          >
            Add condition
          </Button>
        )}
        {firstDimension && canNest(root, path) && (
          <Button
            onClick={() =>
              append({
                ...emptyGroup(),
                op: 'or',
                children: [emptyCondition(firstDimension)],
              })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Add group
          </Button>
        )}
        {!isRoot && (
          <Button
            onClick={() => remove(path)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Remove group
          </Button>
        )}
      </div>
    </div>
  );
}

export function FilterBuilder({
  value,
  onChange,
  dimensions,
  idPrefix,
}: {
  value: FilterGroup;
  onChange: (next: FilterGroup) => void;
  dimensions: Dimension[];
  idPrefix: string;
}) {
  // The root is always a group, so every edit returns one.
  const asRoot = (tree: FilterTree): FilterGroup =>
    'children' in tree ? tree : { op: 'and', children: [tree] };
  const context: BuilderContext = {
    root: value,
    dimensions,
    idPrefix,
    change: (path, update) => onChange(asRoot(updateNode(value, path, update))),
    remove: (path) => onChange(asRoot(removeNode(value, path))),
  };
  return <GroupEditor context={context} group={value} path={[]} />;
}
