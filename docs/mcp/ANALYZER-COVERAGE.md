# Analyzer Coverage

Klauro does not try to deeply understand every package in a dependency tree. The supported surface is intentionally split into languages, frameworks, and architecture-defining libraries: dependencies that shape persistence, security, payments, queues, messaging, caching, observability, AI calls, routing, state, or data-fetching patterns.

## Official Analyzer Families

- **Languages:** TypeScript/JavaScript, Python, Java, C#, Go, Rust, PHP, Ruby, Dart/Flutter, Terraform/HCL.
- **Frameworks:** NestJS, Spring Boot, Django, Flask, FastAPI, Laravel, Symfony, Rails, Express, React, Angular, Vue, Jest, Cypress, WPF, ASP.NET Core, Next.js, Actix-web, Rocket.
- **Dedicated library analyzers:** Prisma, Socket.io, React Router, Redux/RTK, Zustand, TanStack Query, architecture-defining libraries.

## Architecture-Defining Library Coverage

The `architectural-libraries` analyzer detects libraries that materially change how agents should work in a repository. It contributes CAS library records, evidence-backed usage nodes, exit points, and agent guidance. It also supports single-file incremental analysis so these facts do not force remote dirty-tree syncs back to full rebuilds.

Covered categories:

- **ORM and persistence:** TypeORM, Sequelize, Mongoose, Prisma Client, SQLAlchemy, Knex.
- **Auth boundaries:** Passport/JWT, NextAuth/Auth.js, Clerk, Firebase Admin, Supabase, Auth0, django-allauth, fastapi-users, OAuth libraries, Spring Security.
- **Payments:** Stripe, Braintree, PayPal, Square, Adyen.
- **Queues and schedulers:** Bull/BullMQ, Celery, RQ, Sidekiq, Resque, Hangfire, APScheduler, cron-style libraries.
- **Message brokers:** Kafka, RabbitMQ/AMQP, NATS, AWS SQS/SNS, Google Pub/Sub, Spring Kafka, Confluent.Kafka, MassTransit.
- **Cache:** Redis clients and Django Redis.
- **Observability:** OpenTelemetry, Sentry, Datadog, New Relic, Prometheus clients.
- **AI SDKs:** OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Cohere.

## Regression Proof

`npm run analysis-gauntlet` includes `fixtures/analysis-truth/architecture-libraries`, which requires detection of Express plus architecture-defining libraries across ORM, auth, payments, queue, broker, cache, observability, and AI SDK categories. This keeps library coverage in the same truth gate as language and framework coverage.

