import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { CASContribution, CASExitPoint, CASLibrary, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

type ArchitectureLibraryCategory =
  | 'orm'
  | 'database-client'
  | 'auth'
  | 'payments'
  | 'queue'
  | 'message-broker'
  | 'cache'
  | 'observability'
  | 'ai-sdk'
  | 'dependency-injection'
  | 'mediator-cqrs'
  | 'actor-system'
  | 'workflow-engine'
  | 'state-machine'
  | 'service-sdk';

interface ArchitectureLibraryRule {
  name: string;
  displayName: string;
  category: ArchitectureLibraryCategory;
  packageManagers: string[];
  packages: string[];
  usagePatterns: Array<{ label: string; pattern: RegExp; exitType?: CASExitPoint['type']; action?: string; requiresImportEvidence?: boolean }>;
  agentGuidance: string;
  /** Other rule names whose usage-pattern symbols this rule's patterns may collide with
   * (e.g. TypeORM's bare `EntityManager`/`Repository<` also match MikroORM). When a rule
   * lists conflictsWith, requiresImportEvidence patterns are gated on real per-file import
   * source, never on bare symbol/dependency presence alone. */
  conflictsWith?: string[];
}

interface ArchitecturalLibraryAnalyzerOptions {
  id?: string;
  displayName?: string;
  categories?: ArchitectureLibraryCategory[];
  ruleNames?: string[];
  libraryFamily?: string;
}

interface DependencyHit {
  name: string;
  version?: string;
  type: CASLibrary['type'];
  packageManager: string;
}

interface UsageHit {
  file: string;
  line: number;
  pattern: string;
  excerpt: string;
}

const RULES: ArchitectureLibraryRule[] = [
  rule('typeorm', 'TypeORM', 'orm', ['npm'], ['typeorm'], [
    // Bare `EntityManager` / `getRepository` / `DataSource` also appear verbatim in
    // MikroORM (@mikro-orm/core) and other ORMs, so this pattern is gated on the file
    // actually importing from 'typeorm' (see requiresImportEvidence handling below),
    // not just the symbol name or the package being declared anywhere in the repo.
    usage('repository access', /\b(getRepository|Repository<|DataSource|EntityManager)\b/, 'database', 'query', true),
    usage('entity decorators', /\b@(Entity|Column|PrimaryGeneratedColumn|ManyToOne|OneToMany)\b/, undefined, undefined, true),
    usage('migration', /\b(MigrationInterface|QueryRunner)\b/, undefined, undefined, true),
  ], 'Preserve repository/entity/migration boundaries and avoid bypassing TypeORM repositories with ad hoc SQL unless the repo already does that.', ['mikro-orm']),
  rule('mikro-orm', 'MikroORM', 'orm', ['npm'], ['@mikro-orm/core', '@mikro-orm/nestjs', '@mikro-orm/postgresql', '@mikro-orm/mysql', '@mikro-orm/sqlite', '@mikro-orm/mongodb'], [
    // `EntityManager` / `EntityRepository<` / `getRepository` collide with TypeORM's
    // symbols of the same name, so this too is gated on real import-source evidence.
    usage('repository access', /\b(getRepository|EntityRepository<|EntityManager)\b/, 'database', 'query', true),
    usage('entity decorators', /\b@(Entity|Property|PrimaryKey|ManyToOne|OneToMany|ManyToMany)\b/, undefined, undefined, true),
    usage('migration', /\b(Migration|MikroORM\.init)\b/, undefined, undefined, true),
  ], 'Preserve repository/entity/migration boundaries and avoid bypassing MikroORM repositories/EntityManager with ad hoc SQL unless the repo already does that.', ['typeorm']),
  rule('sequelize', 'Sequelize', 'orm', ['npm'], ['sequelize'], [
    usage('model definition', /\b(Model\.init|sequelize\.define|DataTypes\.)\b/),
    usage('query', /\b(findAll|findOne|create|update|destroy)\s*\(/, 'database', 'query'),
    usage('transaction', /\btransaction\s*\(/),
  ], 'Follow existing Sequelize model and transaction conventions; preserve model-level validation and association patterns.'),
  rule('mongoose', 'Mongoose', 'orm', ['npm'], ['mongoose'], [
    usage('schema definition', /\bnew\s+Schema\s*\(|mongoose\.Schema\b/),
    usage('model access', /\bmongoose\.model\b|\b(find|findOne|create|updateOne|deleteOne)\s*\(/, 'database', 'query'),
    usage('middleware/hooks', /\b(pre|post)\s*\(\s*['"`](save|validate|remove|update)/),
  ], 'Respect Mongoose schema hooks, validation, and model access conventions before adding new persistence paths.'),
  rule('prisma-client', 'Prisma Client', 'orm', ['npm'], ['@prisma/client', 'prisma'], [
    usage('prisma client access', /\bprisma\.[a-zA-Z0-9_]+\.(find|create|update|delete|upsert|aggregate)/, 'database', 'query'),
    usage('transaction', /\bprisma\.\$transaction\b/),
    usage('schema', /\bmodel\s+\w+\s*\{/),
  ], 'Use generated Prisma Client and schema migration flow instead of parallel persistence abstractions.'),
  rule('sqlalchemy', 'SQLAlchemy', 'orm', ['pip'], ['sqlalchemy', 'SQLAlchemy'], [
    usage('session access', /\b(Session|AsyncSession|sessionmaker|scoped_session)\b/, 'database', 'query'),
    usage('model mapping', /\b(declarative_base|Mapped\[|mapped_column|Column\()/),
    usage('query', /\b(select|insert|update|delete)\s*\(/, 'database', 'query'),
  ], 'Preserve SQLAlchemy session lifecycle, model mapping style, and migration boundaries.'),
  rule('knex', 'Knex', 'database-client', ['npm'], ['knex'], [
    usage('query builder', /\bknex\s*\(|\.where\(|\.insert\(|\.update\(|\.delete\(/, 'database', 'query'),
    usage('migration', /\bexports\.(up|down)\b|\bknex\.schema\b/),
  ], 'Follow the established query-builder and migration style; do not introduce another ORM casually.'),
  rule('redis', 'Redis', 'cache', ['npm', 'pip'], ['redis', 'ioredis', '@redis/client', 'django-redis'], [
    usage('cache get/set', /\.(get|set|mget|mset|hget|hset)\s*\(/, 'cache', 'read/write'),
    usage('cache invalidation', /\.(del|expire|ttl|invalidate)\s*\(/, 'cache', 'invalidate'),
    usage('pubsub', /\.(publish|subscribe)\s*\(/, 'message', 'publish/subscribe'),
  ], 'Preserve cache-key naming, TTL, and invalidation conventions; cache changes must account for stale reads.'),
  rule('passport', 'Passport/Auth Middleware', 'auth', ['npm', 'pip', 'maven', 'gradle'], ['passport', 'jsonwebtoken', 'jwks-rsa', 'next-auth', '@auth/core', '@clerk/nextjs', '@clerk/clerk-sdk-node', 'firebase-admin', '@supabase/supabase-js', 'auth0', 'django-allauth', 'fastapi-users', 'oauthlib', 'spring-security'], [
    usage('guard/middleware', /\b(passport|jwt|auth|authorize|requireAuth|withAuth|middleware)\b/),
    usage('token validation', /\b(verify|decode|signIn|signOut|getServerSession|auth0|clerk|supabase)\b/),
    usage('role or permission', /\b(role|permission|policy|scope|claims)\b/),
  ], 'Treat auth libraries as security boundaries; new routes and mutations must match existing guard, role, and session conventions.'),
  rule('stripe', 'Payments SDK', 'payments', ['npm', 'pip', 'maven', 'gradle', 'nuget'], ['stripe', '@stripe/stripe-js', 'braintree', '@paypal/checkout-server-sdk', 'square', '@adyen/api-library', 'Stripe.net'], [
    usage('payment sdk call', /\b(stripe|braintree|paypal|adyen|square)\.[a-zA-Z0-9_.]+\s*\(/, 'sdk', 'payment-call'),
    usage('webhook handling', /\b(webhook|constructEvent|signature|checkout\.session)\b/, 'webhook', 'receive'),
    usage('idempotency', /\b(idempotency|idempotent|refund|invoice|subscription)\b/),
  ], 'Payment changes must preserve webhook signature validation, idempotency, retries, and billing entity consistency.'),
  rule('bullmq', 'BullMQ Job Queue', 'queue', ['npm'], ['bullmq', 'bull', 'bee-queue'], [
    usage('job producer', /\b(add|enqueue|delay|perform_async|apply_async|send_task)\s*\(/, 'message', 'enqueue'),
    usage('job handler', /\b(process|Worker|@shared_task|perform|handle)\b/),
    usage('schedule', /\b(cron|schedule|repeat|beat_schedule|RecurringJob)\b/, 'event', 'schedule'),
    usage('retry behavior', /\b(retry|attempts|backoff|dead.?letter|failed)\b/),
  ], 'BullMQ changes must preserve queue names, worker payload contracts, retry/backoff behavior, Redis assumptions, and scheduled execution semantics.'),
  rule('celery', 'Celery Task Queue', 'queue', ['pip'], ['celery'], [
    usage('task producer', /\b(apply_async|delay|send_task)\s*\(/, 'message', 'enqueue'),
    usage('task definition', /\b@(?:shared_task|app\.task|celery\.task)\b|\bCelery\s*\(/),
    usage('schedule', /\b(beat_schedule|crontab|periodic_task)\b/, 'event', 'schedule'),
    usage('retry behavior', /\b(retry|autoretry_for|max_retries|retry_backoff|acks_late)\b/),
  ], 'Celery changes must preserve task names, broker/result-backend behavior, retry/ack semantics, and beat schedule ownership.'),
  rule('sidekiq', 'Sidekiq Job Queue', 'queue', ['bundler'], ['sidekiq', 'resque'], [
    usage('job enqueue', /\b(perform_async|perform_in|perform_at|enqueue)\s*\(/, 'message', 'enqueue'),
    usage('worker definition', /\b(include\s+Sidekiq::Worker|Sidekiq::Job|perform\s*\()/),
    usage('schedule/retry', /\b(sidekiq_options|retry|sidekiq-cron|schedule)\b/, 'event', 'schedule'),
  ], 'Sidekiq changes must preserve worker class names, Redis queue names, retry/dead-set behavior, and scheduled job ownership.'),
  rule('hangfire', 'Hangfire Job Queue', 'queue', ['nuget'], ['Hangfire'], [
    usage('job enqueue', /\b(BackgroundJob\.(Enqueue|Schedule)|RecurringJob\.AddOrUpdate)\b/, 'message', 'enqueue'),
    usage('job server', /\b(AddHangfire|UseHangfireServer|HangfireServer)\b/),
    usage('retry/schedule', /\b(AutomaticRetry|RecurringJob|Cron\.)\b/, 'event', 'schedule'),
  ], 'Hangfire changes must preserve job method signatures, queue names, storage backend, retry policy, and recurring-job identity.'),
  rule('cron-schedulers', 'Cron Scheduler', 'queue', ['npm', 'pip'], ['agenda', 'apscheduler', 'node-cron', 'cron', 'rq'], [
    usage('scheduled job', /\b(cron|schedule|every|add_job|BackgroundScheduler|Queue\(|enqueue_at)\b/, 'event', 'schedule'),
    usage('job function', /\b(process|define|func|trigger|perform)\b/),
    usage('retry behavior', /\b(retry|attempts|misfire_grace_time|max_instances|failed)\b/),
  ], 'Cron and scheduler changes must preserve schedule expressions, job identity, overlap behavior, and retry/misfire semantics.'),
  rule('kafka', 'Kafka Message Broker', 'message-broker', ['npm', 'pip', 'maven', 'gradle', 'nuget', 'cargo'], ['kafkajs', 'kafka-python', 'confluent-kafka', 'spring-kafka', 'Confluent.Kafka', 'rdkafka'], [
    usage('producer', /\b(producer|publish|sendMessage|send|emit)\s*\(/, 'message', 'publish'),
    usage('consumer', /\b(consumer|subscribe|consume|eachMessage|onMessage)\b/),
    usage('topic or queue', /\b(topic|queue|routingKey|exchange|subject|subscription)\b/),
    usage('schema/payload', /\b(schema|payload|messageType|contract)\b/),
  ], 'Kafka changes must preserve topic names, partition/keying strategy, consumer groups, schema compatibility, and idempotent processing.'),
  rule('rabbitmq', 'RabbitMQ Message Broker', 'message-broker', ['npm', 'pip', 'maven', 'gradle', 'nuget', 'cargo'], ['amqplib', 'rabbitmq', 'EasyNetQ', 'lapin'], [
    usage('publisher', /\b(publish|sendToQueue|basicPublish|PublishAsync)\s*\(/, 'message', 'publish'),
    usage('consumer', /\b(consume|basicConsume|Subscribe|Received|onMessage)\b/),
    usage('exchange/queue/routing key', /\b(exchange|queue|routingKey|routing_key|binding)\b/),
    usage('ack/retry/dead letter', /\b(ack|nack|dead.?letter|prefetch|durable)\b/),
  ], 'RabbitMQ changes must preserve exchanges, queues, routing keys, ack/nack behavior, durability, and dead-letter flow.'),
  rule('nats', 'NATS Message Broker', 'message-broker', ['npm', 'pip', 'maven', 'gradle', 'nuget', 'cargo'], ['nats', 'nats.ws', 'NATS.Client'], [
    usage('publisher', /\b(publish|request|jetstream|JetStream)\s*\(/, 'message', 'publish'),
    usage('subscriber', /\b(subscribe|consumer|pullSubscribe|queueSubscribe)\b/),
    usage('subject/stream', /\b(subject|stream|durable|consumerName|deliverGroup)\b/),
  ], 'NATS changes must preserve subject names, queue groups, JetStream stream/consumer contracts, durability, and request/reply semantics.'),
  rule('aws-messaging', 'AWS Messaging SDK', 'message-broker', ['npm', 'pip', 'maven', 'gradle'], ['@aws-sdk/client-sqs', '@aws-sdk/client-sns', '@aws-sdk/client-eventbridge', 'boto3'], [
    usage('message publish', /\b(SendMessageCommand|PublishCommand|PutEventsCommand|send_message|publish|put_events)\b/, 'message', 'publish'),
    usage('message consume', /\b(ReceiveMessageCommand|receive_message|DeleteMessageCommand|delete_message)\b/),
    usage('queue/topic/bus', /\b(queueUrl|QueueUrl|TopicArn|EventBusName|detailType|source)\b/),
  ], 'AWS messaging changes must preserve queue/topic/bus ARNs, event detail schema, visibility timeout, retries, and deletion/idempotency behavior.'),
  rule('cloud-pubsub', 'Cloud Pub/Sub and Service Bus', 'message-broker', ['npm', 'pip', 'maven', 'gradle', 'nuget'], ['@google-cloud/pubsub', '@azure/service-bus', 'Azure.Messaging.ServiceBus', 'google-cloud-pubsub'], [
    usage('publish', /\b(publish|publishMessage|sendMessages|ServiceBusMessage)\s*\(/, 'message', 'publish'),
    usage('subscribe/receive', /\b(subscription|subscribe|receiveMessages|processMessage)\b/),
    usage('topic/subscription/queue', /\b(topic|subscription|queueName|fullyQualifiedNamespace)\b/),
  ], 'Cloud broker changes must preserve topic/subscription/queue names, ack/dead-letter behavior, delivery mode, and payload schema.'),
  rule('stream-framework', 'Stream Processing Broker', 'message-broker', ['maven', 'gradle', 'nuget'], ['spring-cloud-stream', 'MassTransit', 'Rebus'], [
    usage('message producer', /\b(Send|Publish|StreamBridge|output|emit)\s*\(/, 'message', 'publish'),
    usage('message handler', /\b(Consumer|Handler|Function<|@StreamListener|ReceiveEndpoint)\b/),
    usage('binding/contract', /\b(binding|destination|exchange|topic|messageType|contract)\b/),
  ], 'Stream framework changes must preserve binding names, message contracts, consumer endpoint ownership, retries, and outbox/idempotency settings.'),
  rule('javascript-di', 'JavaScript DI Container', 'dependency-injection', ['npm'], ['inversify', 'tsyringe', 'typedi', 'awilix'], [
    usage('container binding', /\b(container\.(bind|register|resolve)|bind<|registerSingleton|registerScoped|registerTransient|Add(Singleton|Scoped|Transient)|Container\()/),
    usage('injection decorator', /\b@(injectable|inject|singleton|autoInjectable)\b|\b\[Inject\]|\b@Inject\b/),
    usage('provider registration', /\b(providers|Provider|ServiceCollection|Module|wire|Provide)\b/),
  ], 'JavaScript DI changes must preserve service lifetimes, injection tokens, module registration, and constructor-injection boundaries.'),
  rule('python-di', 'Python DI Container', 'dependency-injection', ['pip'], ['dependency-injector', 'injector', 'punq'], [
    usage('container/provider', /\b(containers\.DeclarativeContainer|providers\.|Binder|Injector|Container\()/),
    usage('injection marker', /\b(Provide\[|@inject|wire\(|Depends\()/),
    usage('provider registration', /\b(singleton|factory|provider|bind)\b/),
  ], 'Python DI changes must preserve provider scope, wiring modules, dependency overrides, and request/job lifecycle boundaries.'),
  rule('java-di', 'Java DI Container', 'dependency-injection', ['maven', 'gradle'], ['com.google.inject:guice', 'guice', 'dagger', 'hilt'], [
    usage('binding/module', /\b(AbstractModule|bind\(|@Provides|@Module|@InstallIn)\b/),
    usage('injection annotation', /\b@(Inject|Singleton|Named|Qualifier|Component)\b/),
    usage('scope', /\b(Singleton|RequestScoped|Scope|Provider<)\b/),
  ], 'Java DI changes must preserve module bindings, qualifiers, scopes, and component graph ownership.'),
  rule('dotnet-di', '.NET DI Container', 'dependency-injection', ['nuget'], ['Microsoft.Extensions.DependencyInjection', 'Autofac', 'SimpleInjector', 'Ninject'], [
    usage('service registration', /\b(AddSingleton|AddScoped|AddTransient|ContainerBuilder|RegisterType|Bind<)\b/),
    usage('resolution/scope', /\b(IServiceProvider|CreateScope|Resolve<|GetRequiredService)\b/),
    usage('module/provider', /\b(IServiceCollection|Module|Provider|LifetimeScope)\b/),
  ], '.NET DI changes must preserve service lifetimes, scopes, registration modules, and constructor-injection boundaries.'),
  rule('nestjs-cqrs', 'NestJS CQRS Bus', 'mediator-cqrs', ['npm'], ['@nestjs/cqrs', 'nestjs-cqrs'], [
    usage('command dispatch', /\b(commandBus\.(execute|publish)|mediator\.send|Send\s*\(|IRequestHandler|CommandHandler|@CommandHandler)\b/, 'message', 'command-dispatch'),
    usage('query dispatch', /\b(queryBus\.execute|IRequest<|IQueryHandler|QueryHandler|@QueryHandler)\b/),
    usage('event dispatch', /\b(eventBus\.(publish|emit)|INotificationHandler|EventsHandler|@EventsHandler|Apply\s*\()\b/, 'message', 'event-publish'),
    usage('handler registration', /\b(Handler|Command|Query|Event|Saga|AggregateRoot)\b/),
  ], 'NestJS CQRS changes must preserve command/query/event contracts, handler ownership, module registration, and aggregate or saga boundaries.'),
  rule('mediatr', 'MediatR Bus', 'mediator-cqrs', ['nuget'], ['MediatR', 'Brighter', 'WolverineFx'], [
    usage('request dispatch', /\b(IMediator|mediator\.Send|Send\s*\(|IRequestHandler|IRequest<)\b/, 'message', 'command-dispatch'),
    usage('notification dispatch', /\b(Publish\s*\(|INotificationHandler|INotification)\b/, 'message', 'event-publish'),
    usage('pipeline behavior', /\b(IPipelineBehavior|Behavior|Handler|Command|Query|Event)\b/),
  ], 'MediatR changes must preserve request/notification contracts, pipeline behaviors, handler ownership, and transaction boundaries.'),
  rule('axon-cqrs', 'Axon CQRS/Event Sourcing', 'mediator-cqrs', ['maven', 'gradle'], ['AxonFramework', 'axon-spring-boot-starter'], [
    usage('command dispatch', /\b(CommandGateway|sendAndWait|@CommandHandler)\b/, 'message', 'command-dispatch'),
    usage('event dispatch', /\b(EventGateway|AggregateLifecycle\.apply|@EventHandler)\b/, 'message', 'event-publish'),
    usage('aggregate/saga', /\b(@Aggregate|@Saga|@EventSourcingHandler|@QueryHandler)\b/),
  ], 'Axon changes must preserve aggregate command handling, event-sourcing handlers, saga boundaries, and event schema compatibility.'),
  rule('python-cqrs', 'Python CQRS/Mediator', 'mediator-cqrs', ['pip'], ['python-cqrs', 'diator'], [
    usage('command/query dispatch', /\b(dispatch|send|Mediator|CommandHandler|QueryHandler)\b/, 'message', 'command-dispatch'),
    usage('event publish', /\b(EventHandler|publish|emit|Notification)\b/, 'message', 'event-publish'),
    usage('handler contract', /\b(Command|Query|Event|Handler|RequestMap|EventMap)\b/),
  ], 'Python CQRS changes must preserve command/query/event contracts, handler maps, and transaction or unit-of-work boundaries.'),
  rule('akka', 'Akka Actor System', 'actor-system', ['npm', 'maven', 'gradle', 'nuget'], ['akkajs', 'akka-actor', 'akka-stream', 'akka-cluster', 'Akka', 'Akka.Actor'], [
    usage('actor creation', /\b(actorOf|ActorSystem|ReceiveActor|UntypedActor|Props)\b/),
    usage('message send', /\b(tell|ask|Tell|Ask|become|context\.actorOf)\s*\(/, 'message', 'actor-message'),
    usage('supervision/stream/cluster', /\b(SupervisorStrategy|Materializer|Source|Sink|Cluster|Sharding|Persistence)\b/),
  ], 'Akka changes must preserve actor identity, supervision strategy, ask/tell semantics, mailbox/cluster assumptions, streams, and message contracts.'),
  rule('orleans', 'Microsoft Orleans', 'actor-system', ['nuget'], ['Microsoft.Orleans', 'Orleans'], [
    usage('grain contract', /\b(IGrain|Grain<|GrainFactory|GetGrain)\b/),
    usage('grain call', /\b(GetGrain|SendReminder|RegisterOrUpdateReminder|RegisterTimer)\s*\(/, 'message', 'actor-message'),
    usage('activation/state', /\b(PersistentState|GrainId|OnActivateAsync|Reminder|StreamProvider)\b/),
  ], 'Orleans changes must preserve grain interfaces, grain identity, activation/state model, reminders/timers, streams, and call contracts.'),
  rule('ray', 'Ray Actor System', 'actor-system', ['pip'], ['ray'], [
    usage('remote task/actor', /\b@ray\.remote\b|\b\.remote\s*\(/),
    usage('object ref use', /\b(ray\.get|ray\.wait|ObjectRef|ActorHandle)\b/, 'message', 'actor-message'),
    usage('resource placement', /\b(num_cpus|num_gpus|resources|placement_group|runtime_env)\b/),
  ], 'Ray changes must preserve remote task and actor contracts, resource requirements, object refs, and placement assumptions.'),
  rule('python-actors', 'Python Actor Library', 'actor-system', ['pip'], ['thespian', 'pykka'], [
    usage('actor creation', /\b(ActorSystem|createActor|ThreadingActor|spawn)\b/),
    usage('message send', /\b(tell|ask|send|receiveMessage)\s*\(/, 'message', 'actor-message'),
    usage('actor contract', /\b(Actor|ActorRef|ActorTypeDispatcher|on_receive)\b/),
  ], 'Python actor changes must preserve actor identity, message contracts, lifecycle hooks, and concurrency assumptions.'),
  rule('temporal', 'Temporal Workflow Engine', 'workflow-engine', ['npm', 'pip', 'maven', 'gradle'], ['@temporalio/client', '@temporalio/worker', 'temporalio'], [
    usage('workflow definition', /\b(workflow|Workflow|orchestrator|DurableOrchestrationContext|defineSignal|defineQuery|@workflow\.defn)\b/),
    usage('activity/task definition', /\b(activity|Activity|executeActivity|call_activity|@activity\.defn|schedule_activity_task|newWorker)\b/, 'message', 'activity-dispatch'),
    usage('workflow signal/query', /\b(signal|query|continueAsNew|startWorkflow|workflowId|instanceId)\b/, 'message', 'workflow-signal'),
    usage('retry/timeout policy', /\b(retryPolicy|RetryOptions|timeout|heartbeat|compensation|saga)\b/),
  ], 'Temporal changes must preserve workflow IDs, activity contracts, task queues, signal/query names, retry policy, and deterministic workflow rules.'),
  rule('durable-functions', 'Azure Durable Functions', 'workflow-engine', ['npm', 'nuget'], ['durable-functions', 'azure-functions-durable-js', 'Microsoft.Azure.WebJobs.Extensions.DurableTask'], [
    usage('orchestrator definition', /\b(orchestrator|DurableOrchestrationContext|df\.orchestrator|IDurableOrchestrationContext)\b/),
    usage('activity dispatch', /\b(callActivity|CallActivityAsync|callSubOrchestrator|CreateTimer)\b/, 'message', 'activity-dispatch'),
    usage('entity/signal', /\b(signalEntity|RaiseEventAsync|WaitForExternalEvent|ContinueAsNew)\b/, 'message', 'workflow-signal'),
  ], 'Durable Functions changes must preserve orchestrator determinism, activity names, instance IDs, external events, and retry/timer semantics.'),
  rule('camunda-zeebe', 'Camunda/Zeebe Workflow Engine', 'workflow-engine', ['npm', 'maven', 'gradle'], ['zeebe-client-node-js', 'camunda-bpm', 'camunda-external-task-client-js'], [
    usage('workflow client', /\b(ZBClient|ZeebeClient|RuntimeService|TaskService|ExternalTaskClient)\b/),
    usage('job/activity worker', /\b(createWorker|subscribe|complete|handleFailure|newCreateInstanceCommand)\b/, 'message', 'activity-dispatch'),
    usage('process variables', /\b(processDefinitionKey|bpmnProcessId|variables|businessKey)\b/),
  ], 'Camunda/Zeebe changes must preserve BPMN process IDs, job types, variable contracts, worker retries, and incident/failure handling.'),
  rule('python-data-workflow', 'Python Data Workflow Engine', 'workflow-engine', ['pip'], ['airflow', 'prefect', 'dagster'], [
    usage('workflow definition', /\b(DAG\(|@dag|@flow|@job|define_asset_job)\b/),
    usage('task/activity definition', /\b(@task|PythonOperator|op\(|asset\(|flow\.serve)\b/, 'message', 'activity-dispatch'),
    usage('schedule/retry', /\b(schedule_interval|cron_schedule|retries|retry_delay|Deployment|sensor)\b/),
  ], 'Airflow/Prefect/Dagster changes must preserve DAG/flow/job identity, schedules, task contracts, retries, and data dependency semantics.'),
  rule('xstate', 'XState State Machine', 'state-machine', ['npm'], ['xstate', '@xstate/react', '@xstate/fsm'], [
    usage('machine definition', /\b(createMachine|Machine\(|GraphMachine|StateMachine|Configure\(|stateMachineFactory)\b/),
    usage('transition definition', /\b(on:\s*\{|transitions|permit|PermitIf|trigger|guard|assign\(|sendTo\()/),
    usage('interpreter/service', /\b(interpret|useMachine|actor\.send|service\.send|start\(\))\b/),
  ], 'XState changes must preserve states, events, guards, actions, actor services, and side-effect boundaries rather than scattering conditional flow elsewhere.'),
  rule('python-state-machine', 'Python State Machine', 'state-machine', ['pip'], ['transitions', 'python-statemachine'], [
    usage('machine definition', /\b(Machine\(|StateMachine|State\(|states\s*=)\b/),
    usage('transition definition', /\b(transitions\s*=|add_transition|to=|source=|dest=|conditions=)\b/),
    usage('callback/guard', /\b(before|after|conditions|unless|on_enter|on_exit)\b/),
  ], 'Python state-machine changes must preserve state names, transitions, guards, callbacks, and model lifecycle assumptions.'),
  rule('spring-state-machine', 'Spring StateMachine', 'state-machine', ['maven', 'gradle'], ['spring-statemachine'], [
    usage('machine config', /\b(@EnableStateMachine|StateMachineConfigurerAdapter|StateMachineFactory)\b/),
    usage('transition config', /\b(withExternal|source\(|target\(|event\(|guard\(|action\()\b/),
    usage('machine runtime', /\b(sendEvent|startReactively|StateMachine<)\b/),
  ], 'Spring StateMachine changes must preserve state/event enums, transition config, guards/actions, and lifecycle wiring.'),
  rule('stateless-dotnet', 'Stateless State Machine', 'state-machine', ['nuget'], ['Stateless'], [
    usage('machine definition', /\b(StateMachine<|Configure\(|Permit\(|PermitIf\()\b/),
    usage('transition/action', /\b(OnEntry|OnExit|InternalTransition|FireAsync|TriggerWithParameters)\b/),
  ], 'Stateless changes must preserve state and trigger contracts, guard predicates, entry/exit actions, and async fire semantics.'),
  rule('observability', 'Observability SDK', 'observability', ['npm', 'pip', 'maven', 'gradle', 'nuget'], ['@opentelemetry/api', '@opentelemetry/sdk-node', '@sentry/node', '@sentry/nextjs', 'dd-trace', 'newrelic', 'prom-client', 'sentry-sdk', 'opentelemetry-api', 'OpenTelemetry', 'Sentry', 'prometheus'], [
    usage('tracing setup', /\b(trace|getTracer|startSpan|span|instrumentation)\b/, 'analytics', 'trace'),
    usage('error capture', /\b(captureException|captureMessage|Sentry|logger\.error)\b/, 'analytics', 'error'),
    usage('metrics', /\b(Counter|Gauge|Histogram|metrics|prometheus|recordException)\b/, 'analytics', 'metric'),
  ], 'Preserve instrumentation boundaries and error/metric cardinality when changing observed code paths.'),
  rule('aws-sdk', 'AWS SDK Boundary', 'service-sdk', ['npm', 'pip', 'maven', 'gradle', 'cargo'], ['@aws-sdk/', 'aws-sdk', 'boto3', 'botocore', 'github.com/aws/aws-sdk-go', 'aws-sdk-go-v2'], [
    usage('sdk client construction', /\b(new\s+[A-Z][A-Za-z0-9]*(Client|Service)|boto3\.client|new\s+Octokit|WebClient|Twilio\()/, 'sdk', 'client-create'),
    usage('sdk operation call', /\b(\.send\(|\.request\(|\.apiCall\(|\.messages\.create|\.chat\.postMessage|\.emails\.send|PutObjectCommand|GetObjectCommand)\b/, 'sdk', 'sdk-call'),
    usage('external resource name', /\b(bucket|region|accountId|projectId|workspace|channel|queueUrl|secretName|resourceGroup)\b/),
    usage('boundary reliability', /\b(timeout|retry|maxAttempts|rateLimit|idempotency|backoff|credentials)\b/),
  ], 'AWS SDK changes must preserve resource names, regions, credentials, IAM assumptions, retry/rate-limit behavior, and external contract ownership.'),
  rule('google-cloud-sdk', 'Google Cloud SDK Boundary', 'service-sdk', ['npm', 'pip', 'maven', 'gradle', 'cargo'], ['@google-cloud/', 'google-cloud-', 'google-cloud', 'google.golang.org/api'], [
    usage('sdk client construction', /\b(new\s+[A-Z][A-Za-z0-9]*Client|google\.cloud|build\(|NewService)\b/, 'sdk', 'client-create'),
    usage('sdk operation call', /\b(\.request\(|\.save\(|\.publish\(|\.insert\(|\.execute\()\b/, 'sdk', 'sdk-call'),
    usage('external resource name', /\b(projectId|dataset|bucket|topic|subscription|location|credentials)\b/),
    usage('boundary reliability', /\b(timeout|retry|rateLimit|quota|maxAttempts|credentials)\b/),
  ], 'Google Cloud SDK changes must preserve project/resource names, credentials, retries, quota behavior, and external contract ownership.'),
  rule('azure-sdk', 'Azure SDK Boundary', 'service-sdk', ['npm', 'pip', 'maven', 'gradle', 'nuget'], ['@azure/', 'Azure.'], [
    usage('sdk client construction', /\b(new\s+[A-Z][A-Za-z0-9]*Client|DefaultAzureCredential|ClientSecretCredential)\b/, 'sdk', 'client-create'),
    usage('sdk operation call', /\b(\.send\(|\.get[A-Z]|\.(create|delete|update)[A-Z]|Begin[A-Z])\b/, 'sdk', 'sdk-call'),
    usage('external resource name', /\b(resourceGroup|subscriptionId|tenantId|vaultUrl|queueName|containerName)\b/),
    usage('boundary reliability', /\b(timeout|retry|rateLimit|credential|policy|backoff)\b/),
  ], 'Azure SDK changes must preserve subscription/resource names, credentials, retry policies, and external contract ownership.'),
  rule('github-sdk', 'GitHub SDK Boundary', 'service-sdk', ['npm'], ['Octokit', '@octokit/rest'], [
    usage('client construction', /\b(new\s+Octokit|Octokit\()/, 'sdk', 'client-create'),
    usage('api call', /\b(octokit\.[a-zA-Z0-9_.]+|request\()\b/, 'sdk', 'sdk-call'),
    usage('resource name', /\b(owner|repo|installationId|pull_number|issue_number)\b/),
    usage('boundary reliability', /\b(rateLimit|retry|pagination|etag|throttle)\b/),
  ], 'GitHub SDK changes must preserve installation/auth mode, owner/repo targeting, pagination, rate limits, and webhook/API contracts.'),
  rule('communications-sdk', 'Communications SDK Boundary', 'service-sdk', ['npm'], ['@slack/web-api', '@slack/bolt', 'twilio', '@sendgrid/mail', 'mailgun.js'], [
    usage('client construction', /\b(WebClient|App\(|Twilio\(|mailgun|setApiKey)\b/, 'sdk', 'client-create'),
    usage('operation call', /\b(chat\.postMessage|messages\.create|emails\.send|send\()\b/, 'sdk', 'sdk-call'),
    usage('external resource name', /\b(channel|workspace|phoneNumber|templateId|domain|from|to)\b/),
    usage('boundary reliability', /\b(rateLimit|retry|idempotency|webhook|signature)\b/),
  ], 'Communications SDK changes must preserve workspace/channel/from/to identity, templates, rate limits, webhook signatures, and retry behavior.'),
  rule('openai', 'AI SDK', 'ai-sdk', ['npm', 'pip'], ['openai', '@ai-sdk/openai', 'ai', 'anthropic', '@anthropic-ai/sdk', 'langchain', 'llamaindex', 'cohere', 'cohere-ai'], [
    usage('model call', /\b(chat\.completions|responses\.create|generateText|streamText|messages\.create|invoke)\b/, 'sdk', 'model-call'),
    usage('embedding', /\b(embeddings|embedMany|embed|vector)\b/, 'sdk', 'embedding'),
    usage('tool call', /\b(tool|function_call|tool_calls|agent|Runnable)\b/),
    usage('token/cost boundary', /\b(token|usage|rateLimit|max_tokens|temperature)\b/),
  ], 'AI SDK changes must preserve prompt boundaries, token/cost controls, provider abstraction, and tool-call contracts.'),
];

export class ArchitecturalLibraryAnalyzer extends BaseAnalyzer {
  private readonly selectedRules: ArchitectureLibraryRule[];
  private readonly libraryFamily: string;

  constructor(options: ArchitecturalLibraryAnalyzerOptions = {}) {
    super(
      options.id || 'architectural-libraries',
      options.displayName || 'Architectural Library Analyzer',
      '1.0.0',
      'library'
    );
    this.selectedRules = rulesForSelection(options);
    this.libraryFamily = options.libraryFamily || 'architecture-defining';
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const dependencies = await this.readDependencies(projectPath);
    return this.selectedRules.some(rule => dependencies.some(dep => this.ruleMatchesDependency(rule, dep)));
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.sourceFiles({ projectPath });
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { nodes, exitPoints, libraries } = await this.analyzeArchitectureLibraries(
      context.projectPath,
      await this.sourceFiles(context),
      true
    );

    const contribution = this.createContribution(nodes, [], [], exitPoints, {
      library_family: 'architecture-defining',
      analyzer_family: this.libraryFamily,
      libraries_detected: libraries.length,
      usage_nodes: nodes.length,
      exit_points: exitPoints.length,
      categories: Array.from(new Set(libraries.map(library => library.category).filter(Boolean))),
    });
    contribution.libraries = libraries;
    return contribution;
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    const { nodes, exitPoints } = await this.analyzeArchitectureLibraries(
      context.projectPath,
      [context.relativePath],
      false
    );
    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      [],
      [],
      exitPoints,
      this.extractImports(content),
      nodes.map(node => node.name)
    );
  }

  protected getCapabilities(): string[] {
    return [
      'architecture-defining-library-detection',
      'orm-and-persistence-surface-detection',
      'auth-and-payment-boundary-detection',
      'queue-and-message-contract-detection',
      'di-mediator-actor-workflow-boundary-detection',
      'state-machine-and-service-sdk-boundary-detection',
      'cache-observability-ai-boundary-detection',
      'agent-guidance-for-library-conventions',
    ];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'library boundary' : 'library usage';
  }

  private async sourceFiles(context: AnalysisContext): Promise<string[]> {
    return this.capAndPrioritizeSourceFiles(await glob([
      '**/*.{ts,tsx,js,jsx,py,rb,java,cs,go,rs,php}',
    ], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*', '**/obj/**'],
      nodir: true,
      absolute: false,
    }), 'architecture library candidate files');
  }

  private async findUsages(projectPath: string, files: string[], rule: ArchitectureLibraryRule): Promise<UsageHit[]> {
    const usages: UsageHit[] = [];
    const needsImportEvidence = rule.usagePatterns.some(pattern => pattern.requiresImportEvidence);
    for (const relativeFile of files) {
      const absoluteFile = path.join(projectPath, relativeFile);
      let content = '';
      try {
        content = await fs.readFile(absoluteFile, 'utf8');
      } catch {
        continue;
      }
      if (!this.fileMayUseRule(content, rule)) continue;

      // Import-source evidence: does this file actually import from one of the rule's
      // packages? Computed once per file, reused for every requiresImportEvidence pattern
      // below — this is what prevents a bare shared symbol name (e.g. EntityManager,
      // used verbatim by both typeorm and @mikro-orm/core) from being attributed to a
      // specific framework it wasn't actually imported from.
      const fileImportsRulePackage = needsImportEvidence
        ? this.extractImports(content).some(importSource => rule.packages.some(
            pkg => importSource === pkg || importSource.startsWith(`${pkg}/`)
          ))
        : false;

      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const pattern of rule.usagePatterns) {
          if (pattern.requiresImportEvidence && !fileImportsRulePackage) continue;
          pattern.pattern.lastIndex = 0;
          if (pattern.pattern.test(line)) {
            usages.push({
              file: relativeFile,
              line: index + 1,
              pattern: pattern.label,
              excerpt: line.trim().slice(0, 180),
            });
          }
        }
      });
    }
    return usages;
  }

  private async analyzeArchitectureLibraries(
    projectPath: string,
    sourceFiles: string[],
    includeLibraries: boolean
  ): Promise<{ nodes: CASNode[]; exitPoints: CASExitPoint[]; libraries: CASLibrary[] }> {
      const dependencies = await this.readDependencies(projectPath);
    const nodes: CASNode[] = [];
    const exitPoints: CASExitPoint[] = [];
    const libraries: CASLibrary[] = [];

    for (const rule of this.selectedRules) {
      const dependencyHits = dependencies.filter(dep => this.ruleMatchesDependency(rule, dep));
      if (dependencyHits.length === 0) continue;
      const usages = await this.findUsages(projectPath, sourceFiles, rule);
      const connectedNodes: string[] = [];

      for (const usageHit of usages.slice(0, 20)) {
        const nodeId = `archlib_${this.sanitizeId(rule.name)}_${this.sanitizeId(usageHit.file)}_${usageHit.line}`;
        connectedNodes.push(nodeId);
        nodes.push(this.createNode(
          nodeId,
          `${rule.displayName}: ${usageHit.pattern}`,
          `library_${rule.category.replace(/-/g, '_')}_usage`,
          4,
          usageHit.file,
          usageHit.line,
          usageHit.line,
          {
            library: rule.displayName,
            package_names: dependencyHits.map(dep => dep.name),
            architecture_category: rule.category,
            usage_pattern: usageHit.pattern,
            agent_guidance: rule.agentGuidance,
            excerpt: usageHit.excerpt,
            subcategories: ['architecture-defining-library', rule.category],
          }
        ));
      }

      for (const usagePattern of rule.usagePatterns.filter(pattern => pattern.exitType)) {
        const matches = usages.filter(hit => hit.pattern === usagePattern.label);
        for (const hit of matches.slice(0, 8)) {
          const sourceNode = connectedNodes.find(id => id.endsWith(`_${hit.line}`)) || connectedNodes[0] || `library_${this.sanitizeId(rule.name)}`;
          exitPoints.push(this.createExitPoint(
            `exit_archlib_${this.sanitizeId(rule.name)}_${this.sanitizeId(hit.file)}_${hit.line}`,
            sourceNode,
            usagePattern.exitType!,
            `${rule.displayName}: ${usagePattern.label}`,
            `${rule.displayName} ${usagePattern.label} usage detected in ${hit.file}.`,
            { service_id: rule.name, sdk: rule.displayName, resource: rule.category },
            { action: usagePattern.action, async: ['queue', 'message-broker', 'mediator-cqrs', 'actor-system', 'workflow-engine', 'state-machine', 'ai-sdk', 'payments', 'service-sdk'].includes(rule.category) },
            { library: rule.name, category: rule.category, file: hit.file, line: hit.line }
          ));
        }
      }

      if (!includeLibraries) continue;
      for (const dep of dependencyHits) {
        libraries.push({
          id: `lib_${this.sanitizeId(dep.name)}`,
          name: dep.name,
          version: dep.version,
          type: dep.type,
          package_manager: dep.packageManager,
          category: rule.category,
          description: `${rule.displayName} is an architecture-defining ${rule.category} dependency. ${rule.agentGuidance}`,
          usage_patterns: rule.usagePatterns.map(pattern => ({
            pattern: pattern.label,
            occurrences: usages.filter(hit => hit.pattern === pattern.label).length,
            example_nodes: connectedNodes.slice(0, 5),
            functions_used: usages.filter(hit => hit.pattern === pattern.label).slice(0, 5).map(hit => hit.excerpt),
          })),
          usage_statistics: {
            import_count: usages.length,
            usage_frequency: usages.length > 10 ? 'high' : usages.length > 3 ? 'medium' : usages.length > 0 ? 'low' : 'declared-only',
            critical_path: ['auth', 'payments', 'orm', 'database-client', 'queue', 'message-broker', 'dependency-injection', 'mediator-cqrs', 'actor-system', 'workflow-engine', 'state-machine', 'ai-sdk', 'service-sdk'].includes(rule.category),
          },
          connected_nodes: connectedNodes,
          metadata: {
            breaking_changes_risk: ['auth', 'payments', 'orm', 'message-broker', 'dependency-injection', 'mediator-cqrs', 'actor-system', 'workflow-engine', 'state-machine', 'service-sdk'].includes(rule.category) ? 'high' : 'medium',
          },
        });
      }
    }

    return { nodes, exitPoints, libraries };
  }

  private extractImports(content: string): string[] {
    const imports = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
      const requireMatch = line.match(/\brequire\(['"]([^'"]+)['"]\)/);
      const pythonMatch = line.match(/^\s*(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/);
      const rubyMatch = line.match(/^\s*require\s+['"]([^'"]+)['"]/);
      const value = importMatch?.[1] || requireMatch?.[1] || pythonMatch?.[1] || pythonMatch?.[2] || rubyMatch?.[1];
      if (value) imports.add(value);
    }
    return [...imports];
  }

  private fileMayUseRule(content: string, rule: ArchitectureLibraryRule): boolean {
    const lower = content.toLowerCase();
    return rule.packages.some(pkg => lower.includes(pkg.toLowerCase().replace(/^@/, '').split('/')[0])) ||
      rule.usagePatterns.some(pattern => {
        pattern.pattern.lastIndex = 0;
        return pattern.pattern.test(content);
      });
  }

  private async readDependencies(projectPath: string): Promise<DependencyHit[]> {
    return [
      ...await this.readPackageJsonDependencies(projectPath),
      ...await this.readPythonDependencies(projectPath),
      ...await this.readGemfileDependencies(projectPath),
      ...await this.readCargoDependencies(projectPath),
      ...await this.readJavaDependencies(projectPath),
      ...await this.readDotnetDependencies(projectPath),
    ];
  }

  private async readPackageJsonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!await fs.pathExists(packageJsonPath)) return [];
    const pkg = await fs.readJson(packageJsonPath);
    const hits: DependencyHit[] = [];
    const add = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
      for (const [name, version] of Object.entries(deps || {})) {
        hits.push({ name, version: String(version).replace(/^[\^~>=<]/, ''), type, packageManager: 'npm' });
      }
    };
    add(pkg.dependencies, 'production');
    add(pkg.devDependencies, 'development');
    add(pkg.peerDependencies, 'peer');
    add(pkg.optionalDependencies, 'optional');
    return hits;
  }

  private async readPythonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    const requirements = ['requirements.txt', 'requirements/base.txt', 'requirements/production.txt'];
    for (const file of requirements) {
      const reqPath = path.join(projectPath, file);
      if (!await fs.pathExists(reqPath)) continue;
      const content = await fs.readFile(reqPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = line.trim().match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*([^,;\s]+))?/);
        if (match) hits.push({ name: match[1], version: match[2], type: 'production', packageManager: 'pip' });
      }
    }
    return hits;
  }

  private async readGemfileDependencies(projectPath: string): Promise<DependencyHit[]> {
    const gemfile = path.join(projectPath, 'Gemfile');
    if (!await fs.pathExists(gemfile)) return [];
    const content = await fs.readFile(gemfile, 'utf8');
    return content.split(/\r?\n/)
      .map(line => line.match(/^\s*gem\s+['"]([^'"]+)['"](?:,\s*['"]([^'"]+)['"])?/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map(match => ({ name: match[1], version: match[2], type: 'production' as const, packageManager: 'bundler' }));
  }

  private async readCargoDependencies(projectPath: string): Promise<DependencyHit[]> {
    const cargo = path.join(projectPath, 'Cargo.toml');
    if (!await fs.pathExists(cargo)) return [];
    const content = await fs.readFile(cargo, 'utf8');
    const hits: DependencyHit[] = [];
    let section = '';
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
        continue;
      }
      if (section !== 'dependencies' && section !== 'dev-dependencies') continue;
      const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/);
      if (match) hits.push({ name: match[1], version: match[2] || match[3], type: section === 'dev-dependencies' ? 'development' : 'production', packageManager: 'cargo' });
    }
    return hits;
  }

  private async readDotnetDependencies(projectPath: string): Promise<DependencyHit[]> {
    const csprojFiles = await glob('**/*.csproj', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    const hits: DependencyHit[] = [];
    for (const relativeFile of csprojFiles) {
      const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
      const packageRegex = /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g;
      let match: RegExpExecArray | null;
      while ((match = packageRegex.exec(content)) !== null) {
        hits.push({ name: match[1], version: match[2], type: 'production', packageManager: 'nuget' });
      }
    }
    return hits;
  }

  private async readJavaDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    const pomPath = path.join(projectPath, 'pom.xml');
    if (await fs.pathExists(pomPath)) {
      const content = await fs.readFile(pomPath, 'utf8');
      const dependencyRegex = /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?(?:<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, version: match[3], type: 'production', packageManager: 'maven' });
        hits.push({ name: match[2], version: match[3], type: 'production', packageManager: 'maven' });
      }
    }

    const gradleFiles = await glob(['build.gradle', 'build.gradle.kts', '**/build.gradle', '**/build.gradle.kts'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativeFile of gradleFiles) {
      const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
      const dependencyRegex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*(?:\(?\s*)['"]([^:'"]+):([^:'"]+):?([^'"]*)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, version: match[3] || undefined, type: 'production', packageManager: 'gradle' });
        hits.push({ name: match[2], version: match[3] || undefined, type: 'production', packageManager: 'gradle' });
      }
    }
    return hits;
  }

  private ruleMatchesDependency(rule: ArchitectureLibraryRule, dep: DependencyHit): boolean {
    if (!rule.packageManagers.includes(dep.packageManager)) return false;
    const name = dep.name.toLowerCase();
    return rule.packages.some(pkg => name === pkg.toLowerCase() || name.includes(pkg.toLowerCase()));
  }
}

export class PersistenceLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-persistence-libraries',
      displayName: 'Architecture Persistence Library Analyzer',
      categories: ['orm', 'database-client'],
      libraryFamily: 'persistence-boundaries',
    });
  }
}

export class AuthPaymentBoundaryLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-auth-payment-libraries',
      displayName: 'Architecture Auth and Payment Boundary Analyzer',
      categories: ['auth', 'payments'],
      libraryFamily: 'auth-payment-boundaries',
    });
  }
}

export class QueueLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-queue-libraries',
      displayName: 'Architecture Queue Library Analyzer',
      categories: ['queue'],
      libraryFamily: 'job-queue-boundaries',
    });
  }
}

export class MessageBrokerLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-message-broker-libraries',
      displayName: 'Architecture Message Broker Library Analyzer',
      categories: ['message-broker'],
      libraryFamily: 'message-broker-boundaries',
    });
  }
}

export class DependencyInjectionLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-di-libraries',
      displayName: 'Architecture Dependency Injection Library Analyzer',
      categories: ['dependency-injection'],
      libraryFamily: 'dependency-injection-boundaries',
    });
  }
}

export class MediatorCqrsLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-mediator-cqrs-libraries',
      displayName: 'Architecture Mediator/CQRS Library Analyzer',
      categories: ['mediator-cqrs'],
      libraryFamily: 'mediator-cqrs-boundaries',
    });
  }
}

export class ActorSystemLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-actor-system-libraries',
      displayName: 'Architecture Actor System Library Analyzer',
      categories: ['actor-system'],
      libraryFamily: 'actor-system-boundaries',
    });
  }
}

export class WorkflowEngineLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-workflow-engine-libraries',
      displayName: 'Architecture Workflow Engine Library Analyzer',
      categories: ['workflow-engine'],
      libraryFamily: 'workflow-engine-boundaries',
    });
  }
}

export class StateMachineLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-state-machine-libraries',
      displayName: 'Architecture State Machine Library Analyzer',
      categories: ['state-machine'],
      libraryFamily: 'state-machine-boundaries',
    });
  }
}

export class ServiceSdkLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-service-sdk-libraries',
      displayName: 'Architecture Service SDK Boundary Analyzer',
      categories: ['service-sdk'],
      libraryFamily: 'service-sdk-boundaries',
    });
  }
}

export class RuntimeSupportLibraryAnalyzer extends ArchitecturalLibraryAnalyzer {
  constructor() {
    super({
      id: 'architecture-runtime-support-libraries',
      displayName: 'Architecture Runtime Support Library Analyzer',
      categories: ['cache', 'observability', 'ai-sdk'],
      libraryFamily: 'runtime-support-boundaries',
    });
  }
}

export function architectureDependencyNames(categories?: ArchitectureLibraryCategory[]): string[] {
  return [...new Set(rulesForCategories(categories).flatMap(rule => rule.packages))].sort();
}

export interface ArchitectureLibraryAnalyzerDefinition {
  id: string;
  name: string;
  category: ArchitectureLibraryCategory;
  dependencies: string[];
  analyzer: ArchitecturalLibraryAnalyzer;
}

export function architectureLibraryAnalyzerDefinitions(categories?: ArchitectureLibraryCategory[]): ArchitectureLibraryAnalyzerDefinition[] {
  return rulesForCategories(categories).map(rule => ({
    id: `architecture-${thisSafeRuleId(rule.name)}-library`,
    name: `${rule.displayName} Analyzer`,
    category: rule.category,
    dependencies: [...rule.packages],
    analyzer: new ArchitecturalLibraryAnalyzer({
      id: `architecture-${thisSafeRuleId(rule.name)}-library`,
      displayName: `${rule.displayName} Analyzer`,
      ruleNames: [rule.name],
      libraryFamily: `${rule.name}-boundary`,
    }),
  }));
}

function rulesForSelection(options: ArchitecturalLibraryAnalyzerOptions): ArchitectureLibraryRule[] {
  if (options.ruleNames && options.ruleNames.length > 0) {
    const selectedRules = new Set(options.ruleNames);
    return RULES.filter(rule => selectedRules.has(rule.name));
  }
  return rulesForCategories(options.categories);
}

function rulesForCategories(categories?: ArchitectureLibraryCategory[]): ArchitectureLibraryRule[] {
  if (!categories || categories.length === 0) return RULES;
  const selected = new Set(categories);
  return RULES.filter(rule => selected.has(rule.category));
}

function thisSafeRuleId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function rule(
  name: string,
  displayName: string,
  category: ArchitectureLibraryCategory,
  packageManagers: string[],
  packages: string[],
  usagePatterns: ArchitectureLibraryRule['usagePatterns'],
  agentGuidance: string,
  conflictsWith?: string[]
): ArchitectureLibraryRule {
  return { name, displayName, category, packageManagers, packages, usagePatterns, agentGuidance, conflictsWith };
}

function usage(label: string, pattern: RegExp, exitType?: CASExitPoint['type'], action?: string, requiresImportEvidence?: boolean) {
  return { label, pattern, exitType, action, requiresImportEvidence };
}
