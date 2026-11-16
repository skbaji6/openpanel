import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { TemplateRow } from './campaign-contract';
import {
  addBlock,
  EMAIL_BLOCK_TYPES,
  type EmailBlock,
  type EmailBlockType,
  type EmailContent,
  emailProblems,
  MAX_ALT_LENGTH,
  MAX_EMAIL_BLOCKS,
  MAX_EMAIL_IMAGE_WIDTH,
  MAX_EMAIL_IMAGES,
  MAX_EMAIL_SUBJECT_LENGTH,
  MAX_HEADING_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PARAGRAPH_LENGTH,
  MAX_URL_LENGTH,
  MIN_EMAIL_IMAGE_WIDTH,
  moveBlock,
  removeBlock,
} from './email-blocks';
import { NOT_ADMIN_NOTE } from './use-marketing-role';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { showConfirm } from '@/modals';

const VERSION_CONFLICT = 'version_conflict';
const ANY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PROFILE_PLACEHOLDER = /^profile\.([A-Za-z0-9_]+)$/;
const PLACEHOLDER_HINT =
  'Use {{profile.firstName}} or any other student trait as {{profile.<trait>}}.';
const BLOCK_LABELS: Record<EmailBlockType, string> = {
  heading: 'Heading',
  paragraph: 'Paragraph',
  button: 'Button',
  image: 'Image',
  divider: 'Divider',
};
const IMAGE_LIMITS = `At most ${MAX_EMAIL_IMAGES} images per email, https addresses only, ${MIN_EMAIL_IMAGE_WIDTH} to ${MAX_EMAIL_IMAGE_WIDTH} pixels wide.`;

export interface EmailTemplateForm {
  channel: 'email';
  displayName: string;
  category: 'promotional' | 'service';
  content: EmailContent;
}

interface EmailPreview {
  subject: string;
  body: string;
  text: string;
}

export function emailFormFromRow(row: TemplateRow): EmailTemplateForm {
  const content = row.content as Partial<EmailContent> | null | undefined;
  return {
    channel: 'email',
    displayName: row.displayName,
    category: row.category,
    content: {
      subject: content?.subject ?? '',
      blocks: content?.blocks ?? [],
    },
  };
}

function traitsOf(content: EmailContent): string[] {
  const texts = [content.subject];
  for (const block of content.blocks) {
    if (block.type === 'heading' || block.type === 'paragraph') {
      texts.push(block.text);
    } else if (block.type === 'button') {
      texts.push(block.label);
    } else if (block.type === 'image') {
      texts.push(block.alt);
    }
  }
  const traits = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(ANY_PLACEHOLDER)) {
      const trait = PROFILE_PLACEHOLDER.exec((match[1] ?? '').trim())?.[1];
      if (trait) {
        traits.add(trait);
      }
    }
  }
  return [...traits];
}

function toBody(form: EmailTemplateForm) {
  return {
    channel: 'email' as const,
    displayName: form.displayName.trim(),
    category: form.category,
    content: form.content,
  };
}

function BlockFields({
  block,
  id,
  error,
  onChange,
}: {
  block: EmailBlock;
  id: string;
  error?: string;
  onChange: (block: EmailBlock) => void;
}) {
  switch (block.type) {
    case 'heading':
      return (
        <InputWithLabel
          error={error}
          hint={`The large line of text. ${PLACEHOLDER_HINT}`}
          label="Heading text"
          maxLength={MAX_HEADING_LENGTH}
          onChange={(event) => onChange({ ...block, text: event.target.value })}
          value={block.text}
        />
      );
    case 'paragraph':
      return (
        <WithLabel
          error={error}
          hint={`Plain text, new lines are kept. ${PLACEHOLDER_HINT}`}
          id={`${id}-text`}
          label="Paragraph text"
        >
          <Textarea
            id={`${id}-text`}
            maxLength={MAX_PARAGRAPH_LENGTH}
            onChange={(event) =>
              onChange({ ...block, text: event.target.value })
            }
            rows={4}
            value={block.text}
          />
        </WithLabel>
      );
    case 'button':
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <InputWithLabel
            hint="The text on the button."
            label="Button label"
            maxLength={MAX_LABEL_LENGTH}
            onChange={(event) =>
              onChange({ ...block, label: event.target.value })
            }
            value={block.label}
          />
          <InputWithLabel
            error={error}
            hint="Where the button goes. https:// only."
            label="Button link"
            maxLength={MAX_URL_LENGTH}
            onChange={(event) =>
              onChange({ ...block, url: event.target.value })
            }
            value={block.url}
          />
        </div>
      );
    case 'image':
      return (
        <div className="col gap-2">
          <InputWithLabel
            error={error}
            hint="Where the picture is hosted. https:// only."
            label="Image address"
            maxLength={MAX_URL_LENGTH}
            onChange={(event) =>
              onChange({ ...block, src: event.target.value })
            }
            value={block.src}
          />
          <InputWithLabel
            hint="Shown when the picture is blocked, and read by screen readers."
            label="Image description"
            maxLength={MAX_ALT_LENGTH}
            onChange={(event) =>
              onChange({ ...block, alt: event.target.value })
            }
            value={block.alt}
          />
          <InputWithLabel
            hint={`Optional, ${MIN_EMAIL_IMAGE_WIDTH} to ${MAX_EMAIL_IMAGE_WIDTH} pixels. Empty keeps the natural size, shrunk to fit.`}
            label="Image width"
            max={MAX_EMAIL_IMAGE_WIDTH}
            min={MIN_EMAIL_IMAGE_WIDTH}
            onChange={(event) => {
              const { width: _width, ...rest } = block;
              const raw = event.target.value;
              onChange(raw === '' ? rest : { ...rest, width: Number(raw) });
            }}
            type="number"
            value={block.width ?? ''}
          />
        </div>
      );
    default:
      return (
        <p className="text-muted-foreground text-xs">
          A thin line between two parts of the email.
        </p>
      );
  }
}

function PreviewPanel({ content }: { content: EmailContent }) {
  const marketingFetch = useMarketingFetch();
  const traits = traitsOf(content);
  const [sample, setSample] = useState<Record<string, string>>({});
  const preview = useMutation({
    mutationFn: () =>
      marketingFetch<EmailPreview>('preview', {
        method: 'POST',
        body: JSON.stringify({
          channel: 'email',
          content,
          sample: { profile: sample },
        }),
      }),
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  return (
    <section aria-label="Preview" className="col gap-3 border-t p-4">
      <h3 className="font-medium text-sm">Preview</h3>
      <p className="text-muted-foreground text-xs">
        Renders what you typed with sample values, saved or not. The plain-text
        version is what mail apps without HTML show.
      </p>
      {traits.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {traits.map((trait) => (
            <InputWithLabel
              key={trait}
              label={`Sample ${trait}`}
              onChange={(event) =>
                setSample((current) => ({
                  ...current,
                  [trait]: event.target.value,
                }))
              }
              value={sample[trait] ?? ''}
            />
          ))}
        </div>
      )}
      <div>
        <Button
          loading={preview.isPending}
          onClick={() => preview.mutate()}
          type="button"
          variant="outline"
        >
          Preview
        </Button>
      </div>
      {preview.data && (
        <div className="col gap-2" role="status">
          <p className="font-medium text-sm">{preview.data.subject}</p>
          <iframe
            className="h-96 w-full rounded border bg-white"
            sandbox=""
            srcDoc={preview.data.body}
            title="Email preview"
          />
          <h4 className="font-medium text-xs">Plain-text version</h4>
          <pre className="whitespace-pre-wrap rounded border p-3 text-sm">
            {preview.data.text}
          </pre>
        </div>
      )}
    </section>
  );
}

export function EmailTemplateEditor({
  row,
  initial,
  isAdmin,
  onClose,
}: {
  row?: TemplateRow;
  initial: EmailTemplateForm;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const [form, setForm] = useState(initial);
  const [conflict, setConflict] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [newBlockType, setNewBlockType] = useState<EmailBlockType>('paragraph');
  const nameMissing = form.displayName.trim().length === 0;
  const problems = emailProblems(form.content);
  const blocks = form.content.blocks;
  const dirty =
    isAdmin && JSON.stringify(toBody(form)) !== JSON.stringify(toBody(initial));
  const setBlocks = (next: EmailBlock[]) =>
    setForm((c) => ({ ...c, content: { ...c.content, blocks: next } }));
  const problemOf = (index: number) =>
    showProblems ? problems.find((p) => p.index === index)?.message : undefined;
  const back = () => {
    if (!dirty) {
      onClose();
      return;
    }
    showConfirm({
      title: 'Discard unsaved changes?',
      text: 'Your edits to this template have not been saved.',
      onConfirm: onClose,
    });
  };

  const save = useMutation({
    mutationFn: () => {
      const body = toBody(form);
      if (row) {
        return marketingFetch<TemplateRow>(
          `templates/${encodeURIComponent(row.templateId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              ...body,
              expectedVersion: row.currentVersion,
            }),
          }
        );
      }
      return marketingFetch<TemplateRow>('templates', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess(saved) {
      setConflict(false);
      client.setQueryData(
        queryKey('templates', 'one', saved.templateId),
        saved
      );
      client.invalidateQueries({ queryKey: queryKey('templates') });
      toast.success('Template saved');
      onClose();
    },
    onError(error) {
      if (
        error instanceof MarketingApiError &&
        error.code === VERSION_CONFLICT
      ) {
        setConflict(true);
        client.invalidateQueries({ queryKey: queryKey('templates') });
        return;
      }
      toast.error(describeMarketingError(error));
    },
  });

  const wholeEmailProblems = showProblems
    ? problems.filter((p) => p.index === null)
    : [];

  return (
    <form
      className="card col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setShowProblems(true);
        if (problems.length === 0 && !nameMissing) {
          save.mutate();
        }
      }}
    >
      {conflict && (
        <p
          className="mx-4 mt-4 rounded border border-destructive p-3 text-sm"
          role="alert"
        >
          Someone else changed this template. Close this editor and open it
          again to see the latest version before saving.
        </p>
      )}
      <h2 className="p-4 pb-0 font-medium text-lg">
        {row ? `Edit ${row.displayName}` : 'New email template'}
      </h2>
      <fieldset className="col gap-4 p-4" disabled={!isAdmin}>
        <InputWithLabel
          error={showProblems && nameMissing ? 'Name is required' : undefined}
          hint="Only for you, to recognise the template in lists"
          label="Name"
          onChange={(event) =>
            setForm((c) => ({ ...c, displayName: event.target.value }))
          }
          value={form.displayName}
        />
        <InputWithLabel
          hint={`The email subject line. ${PLACEHOLDER_HINT}`}
          label="Subject"
          maxLength={MAX_EMAIL_SUBJECT_LENGTH}
          onChange={(event) =>
            setForm((c) => ({
              ...c,
              content: { ...c.content, subject: event.target.value },
            }))
          }
          value={form.content.subject}
        />
        {wholeEmailProblems.map((problem) => (
          <p
            className="text-destructive text-sm"
            key={problem.message}
            role="alert"
          >
            {problem.message}
          </p>
        ))}
        <ol className="col gap-3">
          {blocks.map((block, index) => {
            const id = `email-block-${index}`;
            const label = BLOCK_LABELS[block.type];
            return (
              <li
                className="col gap-2 rounded border p-3"
                // Blocks have no ids and only the buttons below reorder them.
                key={id}
              >
                <div className="row items-center justify-between gap-2">
                  <h3 className="font-medium text-sm">{`${index + 1}. ${label}`}</h3>
                  <div className="row gap-1">
                    <Button
                      aria-label={`Move ${label.toLowerCase()} ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() =>
                        setBlocks(moveBlock(blocks, index, index - 1))
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Up
                    </Button>
                    <Button
                      aria-label={`Move ${label.toLowerCase()} ${index + 1} down`}
                      disabled={index === blocks.length - 1}
                      onClick={() =>
                        setBlocks(moveBlock(blocks, index, index + 1))
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Down
                    </Button>
                    <Button
                      aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                      onClick={() => setBlocks(removeBlock(blocks, index))}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <BlockFields
                  block={block}
                  error={problemOf(index)}
                  id={id}
                  onChange={(next) =>
                    setBlocks(blocks.map((b, i) => (i === index ? next : b)))
                  }
                />
              </li>
            );
          })}
        </ol>
        <div className="col gap-2">
          <div className="row items-end gap-2">
            <WithLabel
              hint={`Up to ${MAX_EMAIL_BLOCKS} blocks. ${IMAGE_LIMITS}`}
              id="email-new-block-type"
              label="Add a block"
            >
              <select
                className="h-9 rounded border bg-background px-2 text-sm"
                id="email-new-block-type"
                onChange={(event) =>
                  setNewBlockType(event.target.value as EmailBlockType)
                }
                value={newBlockType}
              >
                {EMAIL_BLOCK_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {BLOCK_LABELS[type]}
                  </option>
                ))}
              </select>
            </WithLabel>
            <Button
              onClick={() =>
                setBlocks(addBlock(blocks, newBlockType, blocks.length))
              }
              type="button"
              variant="outline"
            >
              Add block
            </Button>
          </div>
        </div>
      </fieldset>
      <PreviewPanel content={form.content} />
      <div className="row items-center justify-between gap-2 border-t p-4">
        {isAdmin ? (
          <span />
        ) : (
          <p className="text-muted-foreground text-xs">{NOT_ADMIN_NOTE}</p>
        )}
        <div className="row gap-2">
          <Button onClick={back} type="button" variant="ghost">
            {isAdmin ? 'Cancel' : 'Back'}
          </Button>
          {isAdmin && (
            <Button loading={save.isPending} type="submit">
              Save
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
