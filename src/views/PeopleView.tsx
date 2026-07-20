import { useEffect, useRef, useState } from "react";
import {
  Plus, X, Trash2, Star, Mail, Phone, ExternalLink, GripVertical,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  PersonRow, PersonEmail, PersonPhone, PersonAddress, PersonUrl, PersonCustomField,
} from "../types";
import {
  listPeople, searchPeople, upsertPerson, deletePerson, allLinkTargets,
} from "../db";
import { Button } from "../components/ui";
import { Avatar } from "../components/Avatar";
import { TagEditor, LinksPanel, LinkTarget } from "../components/ItemMeta";

// Type presets for the multi-value editors (matches vCard TYPE params).
const EMAIL_TYPES = ["home", "work", "other"];
const PHONE_TYPES = ["cell", "home", "work", "other"];
const ADDR_TYPES = ["home", "work", "other"];
const URL_TYPES = ["homepage", "work", "social", "other"];

// --- small helpers ------------------------------------------------------------
function parseArr<T>(json: string | null): T[] {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}
const nz = (s: string): string | null => (s.trim() ? s.trim() : null);
const arrOrNull = (a: unknown[]): string | null => (a.length ? JSON.stringify(a) : null);

/** A blank person, used when creating. full_name may be empty (like a new note). */
function emptyPersonInput() {
  return {
    full_name: "", given_name: null, family_name: null, additional_names: null,
    honorific_prefix: null, honorific_suffix: null, nickname: null,
    emails: null, phones: null, addresses: null, organization: null, title: null,
    birthday: null, urls: null, notes: null, photo: null, custom_fields: null,
    favorite: 0,
  };
}

export default function PeopleView({ onChange }: { onChange: () => void }) {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<LinkTarget[]>([]);

  const reload = async () => {
    const list = query.trim() ? await searchPeople(query) : await listPeople();
    setPeople(list);
    setTargets(await allLinkTargets());
  };
  useEffect(() => { void reload(); }, [query]);

  const selected = people.find((p) => p.id === selectedId) ?? null;
  const bump = () => { void reload(); onChange(); };

  async function createPerson() {
    const id = await upsertPerson(emptyPersonInput());
    setQuery("");
    setPeople(await listPeople());
    setTargets(await allLinkTargets());
    setSelectedId(id); // open it immediately for editing
    onChange();
  }

  return (
    <div className="flex h-full">
      {/* People list */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-700">
        <div className="space-y-2 border-b border-neutral-200 p-3 dark:border-neutral-700">
          <Button variant="primary" className="w-full" onClick={createPerson}>
            <span className="flex items-center justify-center gap-1.5"><Plus size={16} /> New person</span>
          </Button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people…"
            className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {people.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`flex w-full items-center gap-3 border-b border-neutral-100 px-3 py-2 text-left dark:border-neutral-800 ${
                selectedId === p.id ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
              }`}
            >
              <Avatar name={p.full_name} photo={p.photo} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 truncate font-medium">
                  {p.favorite === 1 && <Star size={13} className="shrink-0 text-amber-400" fill="currentColor" />}
                  {p.full_name || "New contact"}
                </span>
                {p.organization && <span className="block truncate text-xs text-neutral-400">{p.organization}</span>}
              </span>
            </button>
          ))}
          {people.length === 0 && <p className="p-4 text-sm text-neutral-400">No people found.</p>}
        </div>
      </aside>

      {/* Detail / editor — keyed by id so local state resets on selection change */}
      <div className="flex-1 overflow-y-auto">
        {selected ? (
          <PersonEditor
            key={selected.id}
            person={selected}
            targets={targets}
            onChanged={bump}
            onDeleted={() => { setSelectedId(null); bump(); }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-neutral-400">
            Select or create a person.
          </div>
        )}
      </div>
    </div>
  );
}

// --- editor -------------------------------------------------------------------
interface Draft {
  full_name: string;
  honorific_prefix: string;
  given_name: string;
  additional_names: string;
  family_name: string;
  honorific_suffix: string;
  nickname: string;
  organization: string;
  title: string;
  birthday: string; // yyyy-mm-dd or ""
  notes: string;
  photo: string;
  favorite: boolean;
  emails: PersonEmail[];
  phones: PersonPhone[];
  addresses: PersonAddress[];
  urls: PersonUrl[];
  custom_fields: PersonCustomField[];
}

function toDraft(p: PersonRow): Draft {
  return {
    full_name: p.full_name ?? "",
    honorific_prefix: p.honorific_prefix ?? "",
    given_name: p.given_name ?? "",
    additional_names: p.additional_names ?? "",
    family_name: p.family_name ?? "",
    honorific_suffix: p.honorific_suffix ?? "",
    nickname: p.nickname ?? "",
    organization: p.organization ?? "",
    title: p.title ?? "",
    birthday: p.birthday ?? "",
    notes: p.notes ?? "",
    photo: p.photo ?? "",
    favorite: p.favorite === 1,
    emails: parseArr<PersonEmail>(p.emails),
    phones: parseArr<PersonPhone>(p.phones),
    addresses: parseArr<PersonAddress>(p.addresses),
    urls: parseArr<PersonUrl>(p.urls),
    custom_fields: parseArr<PersonCustomField>(p.custom_fields),
  };
}

function PersonEditor({
  person, targets, onChanged, onDeleted,
}: {
  person: PersonRow;
  targets: LinkTarget[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  // Local state is the source of truth while editing; DB writes are debounced
  // (400ms) and flushed on unmount, so typing stays instant and the row never
  // re-fetches out from under the editor. Same pattern as the Notes editor.
  const [form, setForm] = useState<Draft>(() => toDraft(person));
  const formRef = useRef(form);
  formRef.current = form;
  const firstRender = useRef(true);
  const dirty = useRef(false);
  const saveTimer = useRef<number | null>(null);

  const patch = (p: Partial<Draft>) => setForm((f) => ({ ...f, ...p }));

  async function persist(draft: Draft) {
    await upsertPerson({
      id: person.id,
      full_name: draft.full_name.trim(),
      honorific_prefix: nz(draft.honorific_prefix),
      given_name: nz(draft.given_name),
      additional_names: nz(draft.additional_names),
      family_name: nz(draft.family_name),
      honorific_suffix: nz(draft.honorific_suffix),
      nickname: nz(draft.nickname),
      organization: nz(draft.organization),
      title: nz(draft.title),
      birthday: nz(draft.birthday),
      notes: nz(draft.notes),
      photo: nz(draft.photo),
      favorite: draft.favorite ? 1 : 0,
      emails: arrOrNull(draft.emails.filter((e) => e.value.trim())),
      phones: arrOrNull(draft.phones.filter((e) => e.value.trim())),
      addresses: arrOrNull(draft.addresses.filter(hasAddress)),
      urls: arrOrNull(draft.urls.filter((u) => u.value.trim())),
      custom_fields: arrOrNull(draft.custom_fields.filter((c) => c.label.trim())),
    });
    onChanged();
  }

  // Debounce a save whenever the form changes (skip the initial mount).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    dirty.current = true;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      saveTimer.current = null;
      dirty.current = false;
      await persist(formRef.current);
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // Flush any pending save exactly once, on unmount (switching person/view).
  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    if (dirty.current) void persist(formRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const display = form.full_name.trim() || "New contact";

  return (
    <div className="mx-auto max-w-3xl p-6">
      {/* Header */}
      <div className="mb-4 flex items-center gap-4">
        <Avatar name={display} photo={form.photo} size={56} />
        <input
          value={form.full_name}
          onChange={(e) => patch({ full_name: e.target.value })}
          placeholder="Full name"
          className="flex-1 bg-transparent text-2xl font-bold outline-none"
        />
        <Button variant="ghost" onClick={() => patch({ favorite: !form.favorite })} aria-label={form.favorite ? "Unfavorite" : "Favorite"}>
          <Star size={18} className={form.favorite ? "text-amber-400" : "text-neutral-400"} fill={form.favorite ? "currentColor" : "none"} />
        </Button>
        <Button
          variant="danger"
          onClick={async () => {
            if (confirm(`Delete ${display}? This cannot be undone.`)) {
              if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
              dirty.current = false;
              await deletePerson(person.id);
              onDeleted();
            }
          }}
        >
          <span className="flex items-center gap-1.5"><Trash2 size={15} /> Delete</span>
        </Button>
      </div>

      <div className="space-y-5">
        {/* Basics */}
        <Section title="Details">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nickname"><input value={form.nickname} onChange={(e) => patch({ nickname: e.target.value })} className={inputCls} /></Field>
            <Field label="Birthday"><input type="date" value={form.birthday} onChange={(e) => patch({ birthday: e.target.value })} className={inputCls} /></Field>
            <Field label="Organization"><input value={form.organization} onChange={(e) => patch({ organization: e.target.value })} className={inputCls} /></Field>
            <Field label="Title"><input value={form.title} onChange={(e) => patch({ title: e.target.value })} className={inputCls} /></Field>
          </div>
        </Section>

        {/* Structured name (vCard N) */}
        <Section title="Name details">
          <div className="grid grid-cols-5 gap-2">
            <Field label="Prefix"><input value={form.honorific_prefix} onChange={(e) => patch({ honorific_prefix: e.target.value })} className={inputCls} /></Field>
            <Field label="First"><input value={form.given_name} onChange={(e) => patch({ given_name: e.target.value })} className={inputCls} /></Field>
            <Field label="Middle"><input value={form.additional_names} onChange={(e) => patch({ additional_names: e.target.value })} className={inputCls} /></Field>
            <Field label="Last"><input value={form.family_name} onChange={(e) => patch({ family_name: e.target.value })} className={inputCls} /></Field>
            <Field label="Suffix"><input value={form.honorific_suffix} onChange={(e) => patch({ honorific_suffix: e.target.value })} className={inputCls} /></Field>
          </div>
        </Section>

        {/* Emails */}
        <Section title="Email">
          <TypedValueRows
            rows={form.emails}
            typeOptions={EMAIL_TYPES}
            placeholder="name@example.com"
            onChange={(rows) => patch({ emails: rows })}
            onOpen={(v) => void openUrl(`mailto:${v}`)}
            openIcon={<Mail size={14} />}
          />
        </Section>

        {/* Phones */}
        <Section title="Phone">
          <TypedValueRows
            rows={form.phones}
            typeOptions={PHONE_TYPES}
            placeholder="+1 555 010 1234"
            onChange={(rows) => patch({ phones: rows })}
            onOpen={(v) => void openUrl(`tel:${v.replace(/\s+/g, "")}`)}
            openIcon={<Phone size={14} />}
          />
        </Section>

        {/* URLs */}
        <Section title="Websites">
          <TypedValueRows
            rows={form.urls}
            typeOptions={URL_TYPES}
            placeholder="https://example.com"
            onChange={(rows) => patch({ urls: rows })}
            onOpen={(v) => void openUrl(/^https?:\/\//i.test(v) ? v : `https://${v}`)}
            openIcon={<ExternalLink size={14} />}
          />
        </Section>

        {/* Addresses */}
        <Section title="Addresses">
          <AddressRows rows={form.addresses} onChange={(rows) => patch({ addresses: rows })} />
        </Section>

        {/* Custom fields */}
        <Section title="Custom fields">
          <CustomFieldRows rows={form.custom_fields} onChange={(rows) => patch({ custom_fields: rows })} />
        </Section>

        {/* Notes */}
        <Section title="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => patch({ notes: e.target.value })}
            placeholder="Anything worth remembering…"
            rows={3}
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-neutral-700 dark:bg-neutral-800"
          />
        </Section>

        {/* Tags + Links — the cross-app integration */}
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
          <TagEditor type="person" id={person.id} />
          <LinksPanel type="person" id={person.id} targets={targets} />
        </div>
      </div>
    </div>
  );
}

// --- reusable field bits ------------------------------------------------------
const inputCls =
  "w-full rounded border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-700";
const selectCls =
  "rounded border border-neutral-200 px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-700";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

/** Shared editor for emails/phones/urls — a list of {type, value} rows. */
function TypedValueRows({
  rows, typeOptions, placeholder, onChange, onOpen, openIcon,
}: {
  rows: { type: string; value: string }[];
  typeOptions: string[];
  placeholder: string;
  onChange: (rows: { type: string; value: string }[]) => void;
  onOpen: (value: string) => void;
  openIcon: React.ReactNode;
}) {
  const update = (i: number, p: Partial<{ type: string; value: string }>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { type: typeOptions[0], value: "" }]);

  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <select value={r.type} onChange={(e) => update(i, { type: e.target.value })} className={selectCls}>
            {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input value={r.value} onChange={(e) => update(i, { value: e.target.value })} placeholder={placeholder} className={`flex-1 ${inputCls}`} />
          <button
            onClick={() => r.value.trim() && onOpen(r.value.trim())}
            disabled={!r.value.trim()}
            className="rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-blue-500 disabled:opacity-40 dark:hover:bg-neutral-700"
            title="Open"
          >{openIcon}</button>
          <button onClick={() => remove(i)} className="rounded p-1.5 text-neutral-400 hover:text-red-500" aria-label="Remove"><X size={14} /></button>
        </div>
      ))}
      <Button variant="ghost" className="px-1" onClick={add}><span className="flex items-center gap-1"><Plus size={14} /> Add</span></Button>
    </div>
  );
}

function hasAddress(a: PersonAddress): boolean {
  return !!(a.street || a.city || a.region || a.postal_code || a.country);
}

function AddressRows({ rows, onChange }: { rows: PersonAddress[]; onChange: (rows: PersonAddress[]) => void }) {
  const update = (i: number, p: Partial<PersonAddress>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { type: ADDR_TYPES[0] }]);

  return (
    <div className="space-y-2">
      {rows.map((a, i) => (
        <div key={i} className="rounded-lg border border-neutral-200 p-2.5 dark:border-neutral-700">
          <div className="mb-2 flex items-center gap-2">
            <select value={a.type} onChange={(e) => update(i, { type: e.target.value })} className={selectCls}>
              {ADDR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <span className="flex-1" />
            <button onClick={() => remove(i)} className="rounded p-1 text-neutral-400 hover:text-red-500" aria-label="Remove address"><X size={14} /></button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input value={a.street ?? ""} onChange={(e) => update(i, { street: e.target.value })} placeholder="Street" className={`col-span-2 ${inputCls}`} />
            <input value={a.city ?? ""} onChange={(e) => update(i, { city: e.target.value })} placeholder="City" className={inputCls} />
            <input value={a.region ?? ""} onChange={(e) => update(i, { region: e.target.value })} placeholder="Region / State" className={inputCls} />
            <input value={a.postal_code ?? ""} onChange={(e) => update(i, { postal_code: e.target.value })} placeholder="Postal code" className={inputCls} />
            <input value={a.country ?? ""} onChange={(e) => update(i, { country: e.target.value })} placeholder="Country" className={inputCls} />
          </div>
        </div>
      ))}
      <Button variant="ghost" className="px-1" onClick={add}><span className="flex items-center gap-1"><Plus size={14} /> Add address</span></Button>
    </div>
  );
}

/** User-defined label/value rows with drag-to-reorder (HTML5 DnD, like Todos). */
function CustomFieldRows({ rows, onChange }: { rows: PersonCustomField[]; onChange: (rows: PersonCustomField[]) => void }) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const update = (i: number, p: Partial<PersonCustomField>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { label: "", value: "" }]);

  function onDrop(target: number) {
    if (dragIdx === null || dragIdx === target) { setDragIdx(null); return; }
    const next = rows.slice();
    const [moved] = next.splice(dragIdx, 1);
    next.splice(target, 0, moved);
    setDragIdx(null);
    onChange(next);
  }

  return (
    <div className="space-y-1.5">
      {rows.map((c, i) => (
        <div
          key={i}
          draggable
          onDragStart={() => setDragIdx(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => onDrop(i)}
          className="flex items-center gap-2"
        >
          <GripVertical size={15} className="shrink-0 cursor-grab text-neutral-300" />
          <input value={c.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label (e.g. Eye color)" className={`w-40 ${inputCls}`} />
          <input value={c.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="Value (e.g. Blue)" className={`flex-1 ${inputCls}`} />
          <button onClick={() => remove(i)} className="rounded p-1.5 text-neutral-400 hover:text-red-500" aria-label="Remove field"><X size={14} /></button>
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-neutral-400">Add your own fields — a label and a value. They export as vCard X- properties.</p>}
      <Button variant="ghost" className="px-1" onClick={add}><span className="flex items-center gap-1"><Plus size={14} /> Add field</span></Button>
    </div>
  );
}
