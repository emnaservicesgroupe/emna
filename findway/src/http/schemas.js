'use strict';
const { z } = require('zod');
const { E } = require('../lib/errors');

function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) throw E.unprocessable('validation_failed', 'Some fields are invalid', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

const trimmed = (max = 200) => z.string().trim().min(1).max(max);
const opt = (max = 200) => z.string().trim().max(max).optional().nullable().transform((v) => (v === '' ? null : v));
const locale = z.enum(['en', 'ar', 'sq', 'fr']);
const iso2OrName = z.string().trim().min(2).max(80);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const uuid = z.string().uuid();
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code');
const langs = z.array(z.object({ code: z.string().min(2).max(8), level: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native']).optional() })).max(20);

const orgInput = z.object({
  name: trimmed(160), country: opt(80), city: opt(80), industry: opt(80), website: opt(200), registration_number: opt(80), contact_phone: opt(40),
});

const s = {
  register: z.object({
    email: z.string().trim().email().max(200), password: z.string().min(1).max(200), full_name: trimmed(120),
    role: z.enum(['candidate', 'employer_owner', 'agency']), locale: locale.optional(), timezone: z.string().max(60).optional(),
    accept_terms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms and privacy policy' }) }),
    org: orgInput.optional(),
  }).superRefine((v, ctx) => { if (v.role !== 'candidate' && !v.org) ctx.addIssue({ code: 'custom', path: ['org'], message: 'Company details are required' }); }),
  email: z.object({ email: z.string().trim().email().max(200) }),
  verifyEmail: z.object({ email: z.string().trim().email().max(200), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
  login: z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) }),
  loginMfa: z.object({ mfa_token: z.string().min(10).max(200), code: z.string().trim().min(6).max(32) }),
  recoverConfirm: z.object({ email: z.string().trim().email().max(200), code: z.string().regex(/^\d{6}$/), new_password: z.string().min(1).max(200) }),
  code6: z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
  patchMe: z.object({ locale: locale.optional(), timezone: z.string().max(60).optional() }).strict(),

  candidateProfile: z.object({
    full_name: trimmed(120).optional(), phone: opt(40), date_of_birth: dateStr.nullable().optional(), nationality: opt(80), country: opt(80), city: opt(80),
    profession: opt(120), skills: z.array(z.string().trim().min(1).max(60)).max(60).optional(), experience_years: z.number().min(0).max(60).nullable().optional(),
    education: z.array(z.object({ institution: z.string().max(160), degree: z.string().max(160).optional(), year: z.number().int().min(1950).max(2100).optional() })).max(20).optional(),
    certifications: z.array(z.object({ name: z.string().max(160), issuer: z.string().max(160).optional(), year: z.number().int().min(1950).max(2100).optional() })).max(30).optional(),
    languages: langs.optional(), availability_date: dateStr.nullable().optional(), desired_destinations: z.array(z.string().max(80)).max(30).optional(),
    salary_expectation_min: z.number().min(0).nullable().optional(), salary_expectation_max: z.number().min(0).nullable().optional(),
    salary_expectation_currency: currency.nullable().optional(), salary_expectation_period: z.enum(['hour', 'day', 'week', 'month', 'year']).nullable().optional(),
    relocation_preference: opt(300), visibility: z.enum(['private', 'staff_only', 'catalogue_requested']).optional(),
    version: z.number().int().optional(),
  }).strict(),
  consentSet: z.object({ granted: z.boolean() }),
  dataRequest: z.object({ type: z.enum(['export', 'deletion']) }),

  apply: z.object({ job_id: uuid, cover_note: opt(2000) }),
  reasonOnly: z.object({ reason: trimmed(500) }),
  message: z.object({ message: trimmed(2000) }),

  job: z.object({
    title: trimmed(160).optional(), profession: opt(120), category: opt(80), vacancies: z.number().int().min(1).max(10000).optional(),
    country: opt(80), city: opt(80), address: opt(240), latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(),
    description: opt(8000), responsibilities: opt(8000), requirements: opt(8000), experience_min_years: z.number().min(0).max(60).nullable().optional(),
    skills: z.array(z.string().trim().min(1).max(60)).max(40).optional(), languages: langs.optional(),
    salary_specified: z.boolean().optional(), salary_min: z.number().min(0).nullable().optional(), salary_max: z.number().min(0).nullable().optional(),
    salary_currency: currency.nullable().optional(), salary_period: z.enum(['hour', 'day', 'week', 'month', 'year']).nullable().optional(),
    salary_basis: z.enum(['gross', 'net', 'unspecified']).optional(),
    hours_per_day: z.number().min(0).max(24).nullable().optional(), days_per_week: z.number().min(0).max(7).nullable().optional(),
    shifts: opt(300), overtime_terms: opt(500), contract_months: z.number().int().min(0).max(600).nullable().optional(), probation_months: z.number().int().min(0).max(24).nullable().optional(),
    employment_type: z.enum(['full_time', 'part_time', 'contract', 'seasonal', 'temporary']).nullable().optional(),
    work_mode: z.enum(['onsite', 'remote', 'hybrid']).optional(),
    accommodation: z.enum(['provided', 'allowance', 'not_provided', 'unspecified']).optional(), food: z.enum(['provided', 'allowance', 'not_provided', 'unspecified']).optional(),
    transport: z.enum(['provided', 'allowance', 'not_provided', 'unspecified']).optional(), insurance: z.enum(['provided', 'not_provided', 'unspecified']).optional(),
    other_benefits: opt(1000), relocation_support: z.boolean().nullable().optional(), international_recruitment: z.boolean().nullable().optional(),
    employer_confirmed_visa_support: z.boolean().nullable().optional(),
    accepted_formats: z.array(z.enum(['cv', 'video', 'audio', 'portfolio'])).max(4).optional(), deadline: dateStr.nullable().optional(), allow_reapplication: z.boolean().optional(),
    version: z.number().int().optional(),
  }).strict(),
  jobReview: z.object({ decision: z.enum(['approve', 'request_changes', 'reject']), note: opt(1000), override_unverified_reason: opt(500) }),
  closeJob: z.object({ reason: trimmed(300) }),
  companyPatch: z.object({
    name: trimmed(160).optional(), legal_name: opt(200), registration_number: opt(80), website: opt(200), country: opt(80), city: opt(80), industry: opt(80),
    description: opt(4000), contact_phone: opt(40), public_profile: z.boolean().optional(), version: z.number().int().optional(),
  }).strict(),
  verificationSubmit: z.object({ registration_number: trimmed(80), website: opt(200), notes: opt(2000), contact_person: opt(120) }),
  employerAct: z.object({ note: opt(1000), reason: opt(500) }),

  approvalDecision: z.object({ decision: z.enum(['approved', 'rejected']), note: opt(500) }),
  suspension: z.object({ suspended: z.boolean(), reason: opt(300) }),
  createInternal: z.object({ email: z.string().trim().email().max(200), full_name: trimmed(120), role: z.enum(['staff', 'admin']), locale: locale.optional() }),
  orgVerificationDecision: z.object({ decision: z.enum(['verified', 'rejected', 'changes_requested']), note: opt(1000) }),
  leadStatus: z.object({ to: z.enum(['under_review', 'missing_information', 'rejected']), reason: opt(500), message: opt(1000) }),
  qualify: z.object({
    resolution: z.object({ action: z.enum(['merge_into', 'keep_separate']), candidate_id: uuid.optional(), note: opt(500) }).optional(),
    release_to_employer: z.boolean().optional(), disclose_contact: z.boolean().optional(),
  }),
  reassign: z.object({ entity_type: z.enum(['lead', 'candidate', 'organization', 'case']), entity_id: uuid, to_user_id: uuid, reason: trimmed(300) }),
  duplicateResolve: z.object({ action: z.enum(['merge', 'keep_separate']), note: opt(500) }),
  identity: z.object({ kind: z.enum(['passport', 'national_id']), number: trimmed(40), issuing_country: opt(80), issue_date: dateStr.nullable().optional(), expiry_date: dateStr.nullable().optional() }),
  stage: z.object({ to: z.enum(['under_review', 'missing_information', 'shortlisted', 'interview_requested', 'interview_scheduled', 'selected', 'rejected']), reason: opt(500), message: opt(1000) }),
  release: z.object({ release: z.boolean().optional(), disclose_contact: z.boolean().optional() }),
  note: z.object({ entity_type: z.enum(['application', 'organization', 'candidate']), entity_id: uuid, body: trimmed(4000) }),
  requestResolve: z.object({ decision: z.enum(['approve', 'decline']), note: opt(500) }),
  staffCompany: z.object({
    name: trimmed(160), country: opt(80), city: opt(80), industry: opt(80), website: opt(200), registration_number: opt(80), description: opt(2000),
    contact_email: z.string().trim().email().max(200).optional().nullable(), contact_phone: opt(40), source: opt(200), confirm_not_duplicate: z.boolean().optional(),
  }),
  contactLog: z.object({ note: opt(2000), next_action: opt(300), next_action_at: z.string().datetime().nullable().optional() }),
  mode: z.object({ mode: z.enum(['direct', 'managed']) }),
  caseOpen: z.object({ application_id: uuid }),
  caseStage: z.object({ stage: z.enum(['offer', 'documents', 'contract', 'work_permit', 'visa_appointment', 'visa_result', 'travel', 'arrival', 'started_work', 'follow_up', 'closed']), reason: opt(500), version: z.number().int().optional() }),

  integrationConfig: z.object({ base_url: z.string().url().max(300).optional(), enabled: z.boolean().optional() }),
  conflictResolve: z.object({ resolution: z.enum(['local', 'remote']) }),
  subscription: z.object({ url: z.string().url().max(500), events: z.array(z.string().max(60)).min(1).max(20), description: opt(300) }),
  active: z.object({ active: z.boolean() }),
};

const jobSearch = z.object({
  q: z.string().trim().max(100).optional(), profession: z.string().trim().max(120).optional(), country: z.string().trim().max(80).optional(), city: z.string().trim().max(80).optional(),
  experience_years: z.coerce.number().min(0).max(60).optional(),
  skills: z.string().optional().transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10) : undefined)),
  languages: z.string().optional().transform((v) => (v ? v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 5) : undefined)),
  salary_min: z.coerce.number().min(0).optional(), salary_max: z.coerce.number().min(0).optional(), salary_currency: currency.optional(),
  salary_period: z.enum(['hour', 'day', 'week', 'month', 'year']).optional(),
  employment_type: z.enum(['full_time', 'part_time', 'contract', 'seasonal', 'temporary']).optional(), work_mode: z.enum(['onsite', 'remote', 'hybrid']).optional(),
  accommodation: z.enum(['1', 'true']).optional().transform((v) => !!v), relocation_support: z.enum(['1', 'true']).optional().transform((v) => !!v),
  sort: z.enum(['newest', 'deadline', 'salary_desc']).optional(), limit: z.coerce.number().int().min(1).max(50).optional(), offset: z.coerce.number().int().min(0).optional(),
});

module.exports = { parse, s, jobSearch, uuid };
