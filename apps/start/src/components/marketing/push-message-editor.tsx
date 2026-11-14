import { useId } from 'react';
import { type CampaignForm, pushPreview } from './campaign-form';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { Textarea } from '@/components/ui/textarea';

const APP_NAME = 'SIA';
const VARIABLE_EXAMPLE = '{{profile.firstName}}';

type PushField = 'subject' | 'body' | 'imageUrl' | 'link';

function PhonePreview({ form }: { form: CampaignForm }) {
  const preview = pushPreview(form);
  return (
    <figure aria-label="Notification preview" className="col gap-2">
      <figcaption className="text-muted-foreground text-xs">
        Preview. Variables are filled per student when sending.
      </figcaption>
      <div className="w-72 rounded-3xl border bg-muted p-3">
        <div className="col gap-1 rounded-xl bg-background p-3 shadow-sm">
          <div className="row items-center gap-2 text-muted-foreground text-xs">
            <span aria-hidden className="size-4 rounded bg-primary" />
            <span>{APP_NAME}</span>
            <span aria-hidden>·</span>
            <span>now</span>
          </div>
          <div className="row items-start gap-2">
            <div className="col min-w-0 flex-1">
              {preview.title && (
                <p className="truncate font-medium text-sm">{preview.title}</p>
              )}
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm">
                {preview.body || 'Your text appears here'}
              </p>
            </div>
            {preview.imageUrl && (
              <img
                alt=""
                className="size-12 shrink-0 rounded object-cover"
                height={48}
                referrerPolicy="no-referrer"
                src={preview.imageUrl}
                width={48}
              />
            )}
          </div>
        </div>
      </div>
    </figure>
  );
}

export function PushMessageEditor({
  form,
  onChange,
  errorOf,
}: {
  form: CampaignForm;
  onChange: (field: PushField, value: string) => void;
  errorOf: (path: string) => string | undefined;
}) {
  const textId = useId();
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_auto]">
      <div className="col gap-4">
        <p className="text-muted-foreground text-xs">
          {`Title and text can use student details, for example ${VARIABLE_EXAMPLE}. The image and link cannot.`}
        </p>
        <InputWithLabel
          error={errorOf('template.subject')}
          hint="Bold first line of the notification. Optional"
          label="Title"
          onChange={(event) => onChange('subject', event.target.value)}
          value={form.subject}
        />
        <WithLabel error={errorOf('template.body')} id={textId} label="Text">
          <Textarea
            id={textId}
            onChange={(event) => onChange('body', event.target.value)}
            rows={4}
            value={form.body}
          />
        </WithLabel>
        <InputWithLabel
          error={errorOf('template.imageUrl')}
          hint="https link to a picture shown in the notification. Optional"
          label="Image URL"
          onChange={(event) => onChange('imageUrl', event.target.value)}
          value={form.imageUrl}
        />
        <InputWithLabel
          error={errorOf('template.link')}
          hint="Opened when the student taps the notification, for example sia://course/12. Optional"
          label="Link"
          onChange={(event) => onChange('link', event.target.value)}
          value={form.link}
        />
      </div>
      <PhonePreview form={form} />
    </div>
  );
}
