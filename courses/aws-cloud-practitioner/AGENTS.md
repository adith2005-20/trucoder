# AWS Certified Cloud Practitioner (CLF-C02) — course notes for agents

Read the global `../AGENTS.md` first (file format + grading contract). This
file adds this course's specifics.

## Purpose

A one-stop exam-prep course for the **AWS Certified Cloud Practitioner
(CLF-C02)** certification, built from:
1. The **lecture transcripts** in `/tmp/aws-corpus/sections/<NN>-<name>.txt`
   (extracted from 279 course captions — the primary content source).
2. The **slides PDF text** in `/tmp/aws-corpus/pdf/pNNNN.txt` (supplements).
3. Rendered **diagram PNGs** in `courses/aws-cloud-practitioner/assets/`
   (see `/tmp/aws-corpus/images.md` for the manifest — embed with
   `type: image` blocks, `src` relative to `assets/`).

## Lesson map (19 theory + 5 exams)

| # | Lesson id | Source sections |
|---|-----------|-----------------|
| 1 | cloud-concepts | 03 What is Cloud Computing |
| 2 | iam-identity-and-access-management | 04 IAM |
| 3 | ec2-elastic-compute-cloud | 05 EC2 |
| 4 | ec2-instance-storage | 06 EC2 Instance Storage |
| 5 | elb-and-auto-scaling | 07 ELB & ASG |
| 6 | amazon-s3 | 08 Amazon S3 |
| 7 | databases-and-analytics | 09 Databases & Analytics |
| 8 | other-compute-services | 10 ECS/Lambda/Batch/Lightsail |
| 9 | deployments-and-infrastructure | 11 Deployments |
| 10 | global-infrastructure | 12 Global Infrastructure |
| 11 | cloud-integrations | 13 SQS/SNS/Kinesis |
| 12 | cloud-monitoring | 14 CloudWatch/CloudTrail/X-Ray |
| 13 | vpc-and-networking | 15 VPC & Networking |
| 14 | security-and-compliance | 16 Security & Compliance |
| 15 | machine-learning | 17 ML services |
| 16 | account-management-billing-support | 18 Billing & Support |
| 17 | advanced-identity | 19 Advanced Identity |
| 18 | other-services | 20 Other Services |
| 19 | aws-architecting-and-ecosystem | 21 Architecting |
| 20-24 | practice-exam-1 .. practice-exam-5 | 22 Exam prep (fold into exam intros) |

## Format conventions (exam-grade)

- All lessons use `blocks:`. Lesson files: `lessons/NN-<id>.mdx`.
- **Every theory lesson**: 5-7 markdown blocks (context, key concepts with
  bullet lists + tables of services with one-line descriptions, exam traps
  callout `:::tip **Exam tip:**`), ≥1 flowchart (service decision/flow
  diagrams, ≤10 nodes), 2-4 `type: image` blocks embedding the rendered
  diagrams (only when genuinely relevant), and **4 quizzes at the end**
  (mcq/mscq — scenario-based, exam style, with `explanation` on every quiz).
- **Quiz rules**: mcq = exactly one correct option; mscq = 2 correct options
  (pick indices); `answer` indices IN RANGE; options ≥ 3; explanations must
  state why the right answer is right AND why a tempting wrong one is wrong.
  Questions must mirror real CLF-C02 style: scenario → "Which service...?",
  "Which pricing model...?", "Who is responsible for...?" (shared
  responsibility questions are common).
- **Numbers must be accurate** (e.g., S3 11 nines durability 99.999999999%,
  S3 storage class transition 30/90 days, EC2 pricing models, Free Tier
  limits, Support plan prices, Well-Architected pillars count, VPC limits).
  If a transcript/slide gives a number, use it; do NOT invent limits.
- **Flowcharts**: `nodes` (≤10) + `edges` {from, to, label} — 0-indexed.
- **NO `type: code` blocks** in this course (content + quizzes only) — the
  exam is multiple-choice; the platform grades quizzes.
- YAML block scalars: indent exactly 6 spaces (8-10 nested). NO TABS. No
  closing `---` after frontmatter.
- File naming: `NN-<id>.mdx`; frontmatter: id, title, difficulty
  (beginner/easy/medium), order (NN), tags (list), blocks.

## Practice exams (lessons 20-24)

- Each exam = ONE lesson with **65 blocks**: mix of `mcq` (~45) and `mscq`
  (~20), covering ALL domains in the official CLF-C02 weightings:
  Cloud Concepts 24%, Security & Compliance 15%, Technology 34%,
  Billing & Pricing 27%.
- Exam intro markdown block: "65 questions · 90 minutes · passing 700/1000"
  + exam strategy tips (from section 22 transcripts).
- Difficulty medium; questions scenario-based, no repeats across exams.
- Every question has `explanation` (why right + why wrong options are wrong).

## Assets

Rendered diagram PNGs live in `assets/` (see `/tmp/aws-corpus/images.md`).
Image block: `src: <filename>`, `alt`, `caption`. Only embed when the
diagram genuinely matches the lesson topic.
