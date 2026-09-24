use rustc_hash::FxHashMap as HashMap;
use std::sync::LazyLock;

pub struct Known {
    pub name: &'static str,
    pub kind: &'static str,
    pub packages: &'static [&'static str],
    pub hosts: &'static [&'static str],
    pub schemes: &'static [&'static str],
    pub images: &'static [&'static str],
    pub settings: &'static [&'static str],
}

const fn known(
    name: &'static str,
    kind: &'static str,
    packages: &'static [&'static str],
    hosts: &'static [&'static str],
    schemes: &'static [&'static str],
    images: &'static [&'static str],
    settings: &'static [&'static str],
) -> Known {
    Known { name, kind, packages, hosts, schemes, images, settings }
}

impl Known {
    pub fn reached_as(&self) -> &'static str {
        match self.kind {
            "database" | "search" | "vector database" => "database",
            "cache" => "cache",
            "messaging" => "message",
            _ => "api",
        }
    }
}

pub static SERVICES: &[Known] = &[
    known("PostgreSQL", "database",
        &["pg", "pg-promise", "postgres", "postgresql", "psycopg", "psycopg2", "asyncpg", "npgsql",
          "Npgsql.EntityFrameworkCore.PostgreSQL", "org.postgresql", "github.com/lib/pq",
          "github.com/jackc/pgx", "tokio-postgres", "@vercel/postgres"],
        &[], &["postgres", "postgresql"],
        &["postgres", "postgis/postgis", "bitnami/postgresql", "supabase/postgres", "timescale/timescaledb",
          "pgvector/pgvector"],
        &["POSTGRES_", "PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"]),
    known("MySQL", "database",
        &["mysql", "mysql2", "mysqlclient", "pymysql", "aiomysql", "MySqlConnector", "MySql.Data",
          "Pomelo.EntityFrameworkCore.MySql", "github.com/go-sql-driver/mysql", "com.mysql", "mysql.connector"],
        &[], &["mysql"], &["mysql", "bitnami/mysql"], &["MYSQL_"]),
    known("MariaDB", "database", &["mariadb"], &[], &["mariadb"], &["mariadb", "bitnami/mariadb"], &["MARIADB_"]),
    known("SQL Server", "database",
        &["Microsoft.Data.SqlClient", "System.Data.SqlClient", "mssql", "tedious", "com.microsoft.sqlserver"],
        &["database.windows.net"], &["mssql", "sqlserver"], &["mcr.microsoft.com/mssql/server"], &["MSSQL_"]),
    known("MongoDB", "database",
        &["mongodb", "mongoose", "pymongo", "motor", "MongoDB.Driver", "go.mongodb.org/mongo-driver", "mongoid",
          "org.mongodb"],
        &["mongodb.net"], &["mongodb", "mongodb+srv"], &["mongo", "bitnami/mongodb"], &["MONGO_", "MONGODB_"]),
    known("Redis", "cache",
        &["redis", "ioredis", "StackExchange.Redis", "github.com/redis/go-redis", "github.com/go-redis/redis",
          "redis.clients.jedis", "io.lettuce", "redis-om"],
        &["redis.cache.windows.net", "redislabs.com", "redis-cloud.com"], &["redis", "rediss"],
        &["redis", "valkey/valkey", "bitnami/redis", "redis/redis-stack", "redis/redis-stack-server"], &["REDIS_"]),
    known("Memcached", "cache", &["memcached", "pymemcache", "pylibmc", "memjs", "EnyimMemcached"], &[],
        &["memcached"], &["memcached", "bitnami/memcached"], &["MEMCACHED_", "MEMCACHE_"]),
    known("Elasticsearch", "search",
        &["@elastic/elasticsearch", "elasticsearch", "Elastic.Clients.Elasticsearch",
          "github.com/elastic/go-elasticsearch", "co.elastic.clients", "org.elasticsearch"],
        &["elastic-cloud.com", "found.io"], &[],
        &["elasticsearch", "docker.elastic.co/elasticsearch/elasticsearch", "bitnami/elasticsearch"],
        &["ELASTICSEARCH_", "ELASTIC_"]),
    known("OpenSearch", "search", &["@opensearch-project/opensearch", "opensearchpy", "opensearch-py"], &[], &[],
        &["opensearchproject/opensearch"], &["OPENSEARCH_"]),
    known("ClickHouse", "database",
        &["@clickhouse/client", "clickhouse_driver", "clickhouse_connect", "github.com/ClickHouse/clickhouse-go"],
        &["clickhouse.cloud"], &["clickhouse"], &["clickhouse/clickhouse-server", "yandex/clickhouse-server"],
        &["CLICKHOUSE_"]),
    known("Cassandra", "database", &["cassandra-driver", "github.com/gocql/gocql", "com.datastax"], &[], &[],
        &["cassandra", "bitnami/cassandra"], &["CASSANDRA_"]),
    known("Amazon DynamoDB", "database", &["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "dynamoose",
        "AWSSDK.DynamoDBv2"], &[], &[], &["amazon/dynamodb-local"], &["DYNAMODB_"]),
    known("Firebase", "database", &["firebase", "firebase-admin", "@firebase", "firebase_admin"],
        &["firebaseio.com", "firestore.googleapis.com", "firebaseapp.com"], &[], &[], &["FIREBASE_"]),
    known("Supabase", "database", &["@supabase", "supabase"], &["supabase.co"], &[], &[], &["SUPABASE_"]),
    known("Neon", "database", &["@neondatabase/serverless"], &["neon.tech"], &[], &[], &["NEON_"]),
    known("PlanetScale", "database", &["@planetscale/database"], &["psdb.cloud"], &[], &[], &["PLANETSCALE_"]),
    known("Pinecone", "vector database", &["@pinecone-database/pinecone", "pinecone"], &["pinecone.io"], &[], &[],
        &["PINECONE_"]),
    known("Qdrant", "vector database", &["@qdrant/js-client-rest", "qdrant_client"], &["qdrant.io"], &[],
        &["qdrant/qdrant"], &["QDRANT_"]),
    known("Weaviate", "vector database", &["weaviate-client", "weaviate-ts-client", "weaviate"], &["weaviate.network"],
        &[], &["semitechnologies/weaviate"], &["WEAVIATE_"]),
    known("Meilisearch", "search", &["meilisearch"], &["meilisearch.io"], &[], &["getmeili/meilisearch"],
        &["MEILI_", "MEILISEARCH_"]),
    known("Algolia", "search", &["algoliasearch", "@algolia"], &["algolia.net", "algolianet.com", "algolia.io"], &[],
        &[], &["ALGOLIA_"]),
    known("Typesense", "search", &["typesense"], &["typesense.net"], &[], &["typesense/typesense"], &["TYPESENSE_"]),
    known("RabbitMQ", "messaging",
        &["amqplib", "amqp-connection-manager", "pika", "aio_pika", "RabbitMQ.Client",
          "github.com/rabbitmq/amqp091-go", "github.com/streadway/amqp", "bunny", "com.rabbitmq"],
        &["cloudamqp.com"], &["amqp", "amqps"], &["rabbitmq", "bitnami/rabbitmq"], &["RABBITMQ_", "AMQP_"]),
    known("Kafka", "messaging",
        &["kafkajs", "confluent_kafka", "Confluent.Kafka", "github.com/segmentio/kafka-go", "github.com/IBM/sarama",
          "github.com/Shopify/sarama", "org.apache.kafka", "rdkafka", "ruby-kafka"],
        &["confluent.cloud"], &["kafka"],
        &["confluentinc/cp-kafka", "bitnami/kafka", "apache/kafka", "wurstmeister/kafka", "redpandadata/redpanda"],
        &["KAFKA_"]),
    known("NATS", "messaging", &["nats", "github.com/nats-io/nats.go", "nats.aio"], &[], &["nats"], &["nats"],
        &["NATS_"]),
    known("Amazon SQS", "messaging", &["@aws-sdk/client-sqs", "AWSSDK.SQS"], &["sqs.amazonaws.com"], &[], &[],
        &["SQS_"]),
    known("Amazon SNS", "messaging", &["@aws-sdk/client-sns", "AWSSDK.SimpleNotificationService"],
        &["sns.amazonaws.com"], &[], &[], &["SNS_"]),
    known("Google Pub/Sub", "messaging", &["@google-cloud/pubsub", "google.cloud.pubsub", "google.cloud.pubsub_v1",
        "cloud.google.com/go/pubsub"], &["pubsub.googleapis.com"], &[], &[], &["PUBSUB_"]),
    known("Azure Service Bus", "messaging", &["@azure/service-bus", "Azure.Messaging.ServiceBus"],
        &["servicebus.windows.net"], &[], &[], &["SERVICEBUS_", "SERVICE_BUS_"]),
    known("Upstash", "cache", &["@upstash"], &["upstash.io"], &[], &[], &["UPSTASH_"]),
    known("Stripe", "payments",
        &["stripe", "@stripe", "Stripe.net", "Stripe", "github.com/stripe/stripe-go", "com.stripe"],
        &["stripe.com", "stripe.network"], &[], &["stripe/stripe-cli"], &["STRIPE_"]),
    known("PayPal", "payments", &["@paypal", "paypalrestsdk", "paypal-rest-sdk", "com.paypal"],
        &["paypal.com", "paypalobjects.com"], &[], &[], &["PAYPAL_"]),
    known("Braintree", "payments", &["braintree"], &["braintreegateway.com"], &[], &[], &["BRAINTREE_"]),
    known("Adyen", "payments", &["@adyen", "adyen", "Adyen"], &["adyen.com"], &[], &[], &["ADYEN_"]),
    known("Paddle", "payments", &["@paddle"], &["paddle.com"], &[], &[], &["PADDLE_"]),
    known("Lemon Squeezy", "payments", &["@lemonsqueezy"], &["lemonsqueezy.com"], &[], &[], &["LEMONSQUEEZY_"]),
    known("Square", "payments", &["squareup", "square"], &["squareup.com", "squareupsandbox.com"], &[], &[],
        &["SQUARE_"]),
    known("Razorpay", "payments", &["razorpay"], &["razorpay.com"], &[], &[], &["RAZORPAY_"]),
    known("Mollie", "payments", &["@mollie"], &["mollie.com"], &[], &[], &["MOLLIE_"]),
    known("Google Analytics", "analytics",
        &["react-ga", "react-ga4", "ga-4-react", "vue-gtag", "universal-analytics", "@analytics/google-analytics"],
        &["google-analytics.com", "googletagmanager.com", "analytics.google.com"], &[], &[],
        &["GOOGLE_ANALYTICS", "GA_MEASUREMENT", "GA_TRACKING"]),
    known("Amplitude", "analytics", &["@amplitude", "amplitude-js", "amplitude", "amplitude-analytics"],
        &["amplitude.com"], &[], &[], &["AMPLITUDE_"]),
    known("Segment", "analytics", &["@segment", "analytics-node", "analytics-python"], &["segment.io", "segment.com"],
        &[], &[], &["SEGMENT_"]),
    known("Mixpanel", "analytics", &["mixpanel", "mixpanel-browser"], &["mixpanel.com"], &[], &[], &["MIXPANEL_"]),
    known("PostHog", "analytics", &["posthog-js", "posthog-node", "posthog", "posthog-react-native"],
        &["posthog.com"], &[], &["posthog/posthog"], &["POSTHOG_"]),
    known("Plausible", "analytics", &["plausible-tracker", "next-plausible"], &["plausible.io"], &[],
        &["plausible/analytics", "ghcr.io/plausible/community-edition"], &["PLAUSIBLE_"]),
    known("Heap", "analytics", &["reactjs-heap"], &["heap.io", "heapanalytics.com"], &[], &[], &["HEAP_APP_ID", "HEAP_ENV_ID"]),
    known("Hotjar", "analytics", &["@hotjar"], &["hotjar.com"], &[], &[], &["HOTJAR_"]),
    known("Vercel Analytics", "analytics", &["@vercel/analytics", "@vercel/speed-insights"], &[], &[], &[], &[]),
    known("Intercom", "support", &["@intercom", "react-use-intercom", "intercom-client"],
        &["intercom.io", "intercomcdn.com"], &[], &[], &["INTERCOM_"]),
    known("Sentry", "monitoring",
        &["@sentry", "sentry_sdk", "sentry-sdk", "Sentry", "io.sentry", "github.com/getsentry/sentry-go",
          "sentry-ruby", "sentry-rails", "sentry-raven", "sentry"],
        &["sentry.io"], &[], &["getsentry/sentry"], &["SENTRY_"]),
    known("Datadog", "monitoring",
        &["dd-trace", "ddtrace", "datadog", "@datadog", "Datadog.Trace", "gopkg.in/DataDog/dd-trace-go",
          "github.com/DataDog", "datadog-metrics"],
        &["datadoghq.com", "datadoghq.eu", "ddog-gov.com"], &[], &["datadog/agent", "gcr.io/datadoghq/agent"],
        &["DD_", "DATADOG_"]),
    known("New Relic", "monitoring", &["newrelic", "@newrelic", "NewRelic.Agent"], &["newrelic.com", "nr-data.net"],
        &[], &["newrelic/infrastructure"], &["NEW_RELIC_", "NEWRELIC_"]),
    known("Honeycomb", "monitoring", &["@honeycombio", "honeycomb-beeline", "beeline"], &["honeycomb.io"], &[], &[],
        &["HONEYCOMB_"]),
    known("Bugsnag", "monitoring", &["@bugsnag", "bugsnag"], &["bugsnag.com"], &[], &[], &["BUGSNAG_"]),
    known("Rollbar", "monitoring", &["rollbar"], &["rollbar.com"], &[], &[], &["ROLLBAR_"]),
    known("LogRocket", "monitoring", &["logrocket"], &["logrocket.com", "lr-ingest.io"], &[], &[], &["LOGROCKET_"]),
    known("Prometheus", "monitoring",
        &["prom-client", "prometheus_client", "prometheus-net", "github.com/prometheus/client_golang"], &[], &[],
        &["prom/prometheus", "bitnami/prometheus"], &["PROMETHEUS_"]),
    known("Grafana", "monitoring", &[], &["grafana.net", "grafana.com"], &[], &["grafana/grafana", "grafana/loki",
        "grafana/tempo"], &["GRAFANA_"]),
    known("Jaeger", "monitoring", &[], &[], &[], &["jaegertracing/all-in-one", "jaegertracing/jaeger"], &["JAEGER_"]),
    known("OpenTelemetry Collector", "monitoring", &[], &[], &[],
        &["otel/opentelemetry-collector", "otel/opentelemetry-collector-contrib"], &["OTEL_EXPORTER"]),
    known("SendGrid", "email", &["@sendgrid", "sendgrid", "SendGrid"], &["sendgrid.com", "sendgrid.net"], &[], &[],
        &["SENDGRID_"]),
    known("Mailgun", "email", &["mailgun.js", "mailgun-js", "mailgun"], &["mailgun.net", "mailgun.org"], &[], &[],
        &["MAILGUN_"]),
    known("Postmark", "email", &["postmark", "postmarker"], &["postmarkapp.com"], &[], &[], &["POSTMARK_"]),
    known("Resend", "email", &["resend"], &["resend.com"], &[], &[], &["RESEND_"]),
    known("Amazon SES", "email", &["@aws-sdk/client-ses", "@aws-sdk/client-sesv2", "AWSSDK.SimpleEmail"], &[], &[],
        &[], &["SES_"]),
    known("Mailchimp", "email", &["@mailchimp", "mailchimp3", "mailchimp_marketing", "mailchimp_transactional"],
        &["mailchimp.com", "mandrillapp.com"], &[], &[], &["MAILCHIMP_", "MANDRILL_"]),
    known("Brevo", "email", &["@getbrevo", "sib-api-v3-sdk"], &["brevo.com", "sendinblue.com"], &[], &[],
        &["BREVO_", "SENDINBLUE_"]),
    known("Mailjet", "email", &["node-mailjet", "mailjet_rest"], &["mailjet.com"], &[], &[], &["MAILJET_"]),
    known("SMTP server", "email",
        &["nodemailer", "smtplib", "aiosmtplib", "emails", "net/smtp", "System.Net.Mail", "MailKit", "javax.mail",
          "jakarta.mail", "lettre"],
        &[], &["smtp", "smtps"], &["mailhog/mailhog", "axllent/mailpit", "namshi/smtp"],
        &["SMTP_", "EMAIL_HOST", "MAIL_HOST"]),
    known("Twilio", "communication", &["twilio", "Twilio"], &["twilio.com"], &[], &[], &["TWILIO_"]),
    known("Vonage", "communication", &["@vonage", "vonage", "nexmo"], &["nexmo.com", "vonage.com"], &[], &[],
        &["VONAGE_", "NEXMO_"]),
    known("Slack", "communication", &["@slack", "slack_sdk", "slack-sdk", "slack-ruby-client", "slack_bolt"],
        &["slack.com"], &[], &[], &["SLACK_"]),
    known("Discord", "communication", &["discord.js", "discord", "discordrb", "Discord.Net", "serenity"],
        &["discord.com", "discordapp.com"], &[], &[], &["DISCORD_"]),
    known("Telegram", "communication",
        &["node-telegram-bot-api", "telegraf", "telegram", "aiogram", "Telegram.Bot", "teloxide", "grammy"],
        &["api.telegram.org"], &[], &[], &["TELEGRAM_"]),
    known("Pusher", "communication", &["pusher", "pusher-js"], &["pusher.com", "pusherapp.com"], &[], &[],
        &["PUSHER_"]),
    known("Ably", "communication", &["ably"], &["ably.io", "ably.com"], &[], &[], &["ABLY_"]),
    known("OneSignal", "communication", &["onesignal", "@onesignal", "react-onesignal"], &["onesignal.com"], &[], &[],
        &["ONESIGNAL_"]),
    known("Firebase Cloud Messaging", "communication", &[], &["fcm.googleapis.com"], &[], &[], &["FCM_"]),
    known("Expo Push", "communication", &["expo-server-sdk"], &["exp.host"], &[], &[], &[]),
    known("Auth0", "auth", &["auth0", "@auth0", "Auth0"], &["auth0.com"], &[], &[], &["AUTH0_"]),
    known("Clerk", "auth", &["@clerk"], &["clerk.com", "clerk.accounts.dev"], &[], &[], &["CLERK_"]),
    known("Okta", "auth", &["@okta", "okta"], &["okta.com", "oktapreview.com"], &[], &[], &["OKTA_"]),
    known("Amazon Cognito", "auth", &["@aws-sdk/client-cognito-identity-provider", "amazon-cognito-identity-js"],
        &["amazoncognito.com"], &[], &[], &["COGNITO_"]),
    known("WorkOS", "auth", &["@workos-inc"], &["workos.com"], &[], &[], &["WORKOS_"]),
    known("Keycloak", "auth", &["keycloak-js", "keycloak-connect", "keycloak"], &[], &[],
        &["quay.io/keycloak/keycloak", "jboss/keycloak", "keycloak/keycloak"], &["KEYCLOAK_"]),
    known("Google Sign-In", "auth", &["google-auth-library", "@react-oauth/google"],
        &["accounts.google.com", "oauth2.googleapis.com"], &[], &[], &["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]),
    known("GitHub API", "developer platform", &["@octokit", "octokit", "github.com/google/go-github", "Octokit"],
        &["api.github.com"], &[], &[], &["GITHUB_TOKEN", "GITHUB_APP", "GITHUB_CLIENT"]),
    known("GitLab API", "developer platform", &["@gitbeaker", "gitlab"], &["gitlab.com"], &[], &[],
        &["GITLAB_TOKEN"]),
    known("Amazon S3", "storage",
        &["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "@aws-sdk/lib-storage", "AWSSDK.S3", "aws-sdk-s3",
          "github.com/aws/aws-sdk-go-v2/service/s3"],
        &["s3.amazonaws.com"], &["s3"], &[], &["S3_", "AWS_S3", "AWS_BUCKET"]),
    known("MinIO", "storage", &["minio"], &[], &[], &["minio/minio", "bitnami/minio"], &["MINIO_"]),
    known("Google Cloud Storage", "storage", &["@google-cloud/storage", "google.cloud.storage",
        "cloud.google.com/go/storage"], &["storage.googleapis.com"], &["gs"], &[], &["GCS_"]),
    known("Azure Blob Storage", "storage", &["@azure/storage-blob", "Azure.Storage.Blobs", "azure.storage.blob"],
        &["blob.core.windows.net"], &[], &["mcr.microsoft.com/azure-storage/azurite"], &["AZURE_STORAGE"]),
    known("Cloudinary", "storage", &["cloudinary", "next-cloudinary"], &["cloudinary.com"], &[], &[],
        &["CLOUDINARY_"]),
    known("UploadThing", "storage", &["uploadthing", "@uploadthing"], &["uploadthing.com", "utfs.io"], &[], &[],
        &["UPLOADTHING_"]),
    known("Cloudflare R2", "storage", &[], &["r2.cloudflarestorage.com"], &[], &[], &["R2_"]),
    known("Vercel Blob", "storage", &["@vercel/blob"], &["blob.vercel-storage.com"], &[], &[], &["BLOB_READ_WRITE"]),
    known("OpenAI", "ai",
        &["openai", "OpenAI", "Azure.AI.OpenAI", "github.com/sashabaranov/go-openai", "async-openai", "ruby-openai",
          "@ai-sdk/openai"],
        &["openai.com", "openai.azure.com"], &[], &[], &["OPENAI_", "AZURE_OPENAI"]),
    known("Anthropic", "ai", &["@anthropic-ai", "anthropic", "Anthropic", "@ai-sdk/anthropic"], &["anthropic.com"],
        &[], &[], &["ANTHROPIC_", "CLAUDE_API"]),
    known("Google Gemini", "ai", &["@google/generative-ai", "@google/genai", "google.generativeai", "google.genai",
        "@ai-sdk/google"], &["generativelanguage.googleapis.com"], &[], &[], &["GEMINI_"]),
    known("Mistral", "ai", &["@mistralai", "mistralai", "@ai-sdk/mistral"], &["mistral.ai"], &[], &[], &["MISTRAL_"]),
    known("Cohere", "ai", &["cohere-ai", "cohere"], &["cohere.ai", "cohere.com"], &[], &[], &["COHERE_"]),
    known("Groq", "ai", &["groq-sdk", "groq"], &["groq.com"], &[], &[], &["GROQ_"]),
    known("Hugging Face", "ai", &["@huggingface", "huggingface_hub"], &["huggingface.co"], &[], &[],
        &["HUGGINGFACE_", "HF_TOKEN"]),
    known("Replicate", "ai", &["replicate"], &["replicate.com"], &[], &[], &["REPLICATE_"]),
    known("Ollama", "ai", &["ollama"], &[], &[], &["ollama/ollama"], &["OLLAMA_"]),
    known("Amazon Bedrock", "ai", &["@aws-sdk/client-bedrock-runtime", "@ai-sdk/amazon-bedrock"], &[], &[], &[],
        &["BEDROCK_"]),
    known("Deepgram", "ai", &["@deepgram"], &["deepgram.com"], &[], &[], &["DEEPGRAM_"]),
    known("ElevenLabs", "ai", &["elevenlabs"], &["elevenlabs.io"], &[], &[], &["ELEVENLABS_"]),
    known("AssemblyAI", "ai", &["assemblyai"], &["assemblyai.com"], &[], &[], &["ASSEMBLYAI_"]),
    known("Google Maps", "maps", &["@googlemaps", "@react-google-maps", "googlemaps", "@vis.gl/react-google-maps"],
        &["maps.googleapis.com", "maps.google.com"], &[], &[], &["GOOGLE_MAPS"]),
    known("Mapbox", "maps", &["mapbox-gl", "@mapbox", "react-map-gl"], &["mapbox.com"], &[], &[], &["MAPBOX_"]),
    known("Google Calendar", "platform", &["@googleapis/calendar"], &["calendar.googleapis.com"], &[], &[], &[]),
    known("Microsoft Entra ID", "auth", &["@azure/msal-node", "@azure/msal-browser", "msal", "Microsoft.Identity.Client"],
        &["login.microsoftonline.com", "login.live.com"], &[], &[], &["AZURE_AD_", "MSAL_"]),
    known("Vercel Edge Config", "platform", &["@vercel/edge-config"], &["edge-config.vercel.com"], &[], &[],
        &["EDGE_CONFIG"]),
    known("Vercel KV", "cache", &["@vercel/kv"], &[], &[], &[], &["KV_REST_API"]),
    known("Prisma Accelerate", "platform", &["@prisma/extension-accelerate"], &["accelerate.prisma-data.net"], &[],
        &[], &[]),
    known("Google APIs", "platform", &["googleapis", "@googleapis", "googleapiclient", "Google.Apis"],
        &["googleapis.com"], &[], &[], &[]),
    known("Microsoft Graph", "platform", &["@microsoft/microsoft-graph-client", "msgraph", "Microsoft.Graph"],
        &["graph.microsoft.com"], &[], &[], &["MS_GRAPH", "MICROSOFT_GRAPH"]),
    known("Zoom", "communication", &["@zoom"], &["zoom.us"], &[], &[], &["ZOOM_"]),
    known("Daily", "communication", &["@daily-co"], &["daily.co"], &[], &[], &["DAILY_API_KEY", "DAILY_DOMAIN"]),
    known("HubSpot", "crm", &["@hubspot", "hubspot"], &["hubapi.com", "hubspot.com"], &[], &[], &["HUBSPOT_"]),
    known("Salesforce", "crm", &["jsforce", "simple_salesforce"], &["salesforce.com", "force.com"], &[], &[],
        &["SALESFORCE_", "SFDC_"]),
    known("Zendesk", "support", &["node-zendesk", "zenpy"], &["zendesk.com"], &[], &[], &["ZENDESK_"]),
    known("Notion", "platform", &["@notionhq/client"], &["api.notion.com"], &[], &[], &["NOTION_"]),
    known("Airtable", "platform", &["airtable"], &["airtable.com"], &[], &[], &["AIRTABLE_"]),
    known("Shopify", "commerce", &["@shopify"], &["myshopify.com", "shopify.com"], &[], &[], &["SHOPIFY_"]),
    known("Contentful", "cms", &["contentful"], &["contentful.com", "ctfassets.net"], &[], &[], &["CONTENTFUL_"]),
    known("Sanity", "cms", &["@sanity", "next-sanity"], &["sanity.io"], &[], &[], &["SANITY_"]),
    known("Cloudflare", "platform", &["cloudflare"], &["api.cloudflare.com"], &[], &[], &["CLOUDFLARE_"]),
    known("Cloudflare Turnstile", "security", &["@marsidev/react-turnstile"], &["challenges.cloudflare.com"], &[],
        &[], &["TURNSTILE_"]),
    known("hCaptcha", "security", &["@hcaptcha"], &["hcaptcha.com"], &[], &[], &["HCAPTCHA_"]),
    known("reCAPTCHA", "security", &["react-google-recaptcha", "react-google-recaptcha-v3"], &["recaptcha.net"],
        &[], &[], &["RECAPTCHA_"]),
    known("LaunchDarkly", "feature flags", &["@launchdarkly", "launchdarkly"], &["launchdarkly.com"], &[], &[],
        &["LAUNCHDARKLY_", "LD_SDK_KEY"]),
    known("GrowthBook", "feature flags", &["@growthbook", "growthbook"], &["growthbook.io"], &[], &[],
        &["GROWTHBOOK_"]),
    known("Unleash", "feature flags", &["unleash-client", "@unleash"], &["getunleash.io"], &[], &["unleashorg/unleash-server"],
        &["UNLEASH_"]),
    known("Temporal", "workflow", &["@temporalio", "temporalio", "go.temporal.io"], &["temporal.io"], &[],
        &["temporalio/auto-setup", "temporalio/server"], &["TEMPORAL_"]),
    known("Inngest", "workflow", &["inngest"], &["inngest.com"], &[], &["inngest/inngest"], &["INNGEST_"]),
    known("Trigger.dev", "workflow", &["@trigger.dev"], &["trigger.dev"], &[], &[], &["TRIGGER_"]),
    known("HashiCorp Vault", "secrets", &["node-vault", "hvac", "github.com/hashicorp/vault"], &[], &[],
        &["hashicorp/vault", "vault"], &["VAULT_"]),
    known("Consul", "platform", &["consul", "github.com/hashicorp/consul"], &[], &[], &["hashicorp/consul", "consul"],
        &["CONSUL_"]),
    known("etcd", "platform", &["etcd3", "go.etcd.io/etcd"], &[], &[], &["quay.io/coreos/etcd", "bitnami/etcd"],
        &["ETCD_"]),
    known("Google Fonts", "cdn", &["@next/font/google", "next/font/google"], &["fonts.googleapis.com", "fonts.gstatic.com"],
        &[], &[], &[]),
    known("jsDelivr", "cdn", &[], &["cdn.jsdelivr.net"], &[], &[], &[]),
    known("unpkg", "cdn", &[], &["unpkg.com"], &[], &[], &[]),
    known("cdnjs", "cdn", &[], &["cdnjs.cloudflare.com"], &[], &[], &[]),
    known("Nginx", "proxy", &[], &[], &[], &["nginx", "nginxinc/nginx-unprivileged", "bitnami/nginx"], &[]),
    known("Traefik", "proxy", &[], &[], &[], &["traefik"], &[]),
    known("Caddy", "proxy", &[], &[], &[], &["caddy"], &[]),
    known("HAProxy", "proxy", &[], &[], &[], &["haproxy"], &[]),
];

struct Indexes {
    packages: HashMap<String, &'static Known>,
    hosts: HashMap<&'static str, &'static Known>,
    images: HashMap<&'static str, &'static Known>,
    settings: HashMap<&'static str, &'static Known>,
}

static INDEXES: LazyLock<Indexes> = LazyLock::new(|| {
    let mut indexes = Indexes {
        packages: HashMap::default(),
        hosts: HashMap::default(),
        images: HashMap::default(),
        settings: HashMap::default(),
    };
    for known in SERVICES {
        for package in known.packages {
            indexes.packages.entry(package.to_ascii_lowercase()).or_insert(known);
        }
        for host in known.hosts {
            indexes.hosts.entry(host).or_insert(known);
        }
        for image in known.images {
            indexes.images.entry(image).or_insert(known);
        }
        for setting in known.settings {
            indexes.settings.entry(setting).or_insert(known);
        }
    }
    indexes
});

const SEGMENT_ENDS: &[char] = &['/', '.', ':', '-', '_'];

pub fn by_package(specifier: &str) -> Option<&'static Known> {
    let specifier = specifier.trim().trim_start_matches("node:");
    if specifier.starts_with('.') || specifier.is_empty() || !specifier.is_ascii() {
        return None;
    }
    let lowered = specifier.to_ascii_lowercase();
    let packages = &INDEXES.packages;
    if let Some(known) = packages.get(&lowered) {
        return Some(known);
    }
    lowered
        .char_indices()
        .filter(|(_, letter)| SEGMENT_ENDS.contains(letter))
        .map(|(at, _)| &lowered[..at])
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .find_map(|prefix| packages.get(prefix).copied())
}

pub fn by_host(host: &str) -> Option<&'static Known> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let hosts = &INDEXES.hosts;
    std::iter::once(host.as_str())
        .chain(host.char_indices().filter(|(_, letter)| *letter == '.').map(|(at, _)| &host[at + 1..]))
        .find_map(|suffix| hosts.get(suffix).copied())
}

pub fn by_scheme(scheme: &str) -> Option<&'static Known> {
    let scheme = scheme.to_ascii_lowercase();
    SERVICES.iter().find(|known| known.schemes.contains(&scheme.as_str()))
}

pub fn by_image(image: &str) -> Option<&'static Known> {
    let image = image.trim().trim_matches(['"', '\'']).to_ascii_lowercase();
    let image = image.split('@').next().unwrap_or(&image);
    let named = match image.rsplit_once(':') {
        Some((named, tag)) if !tag.contains('/') => named,
        _ => image,
    };
    let unregistered = named.strip_prefix("docker.io/").unwrap_or(named);
    let unregistered = unregistered.strip_prefix("library/").unwrap_or(unregistered);
    let images = &INDEXES.images;
    images.get(unregistered).copied().or_else(|| {
        let leaf = unregistered.rsplit('/').next().unwrap_or(unregistered);
        images.get(leaf).copied()
    })
}

static EXPOSED_BY_A_FRAMEWORK: &[&str] =
    &["EXPO_PUBLIC_", "GATSBY_", "NEXT_PUBLIC_", "NUXT_PUBLIC_", "PUBLIC_", "REACT_APP_", "VITE_", "VUE_APP_"];

pub fn by_setting(name: &str) -> Option<&'static Known> {
    let name = name.trim();
    if !name.is_ascii() {
        return None;
    }
    let name = name.to_ascii_uppercase();
    let name = EXPOSED_BY_A_FRAMEWORK
        .iter()
        .find_map(|prefix| name.strip_prefix(prefix))
        .map(str::to_string)
        .unwrap_or(name);
    let settings = &INDEXES.settings;
    let mut prefixes: Vec<&str> = vec![name.as_str()];
    for (at, letter) in name.char_indices() {
        if letter == '_' {
            prefixes.push(&name[..at]);
            prefixes.push(&name[..=at]);
        }
    }
    prefixes.sort_by_key(|prefix| std::cmp::Reverse(prefix.len()));
    prefixes.into_iter().find_map(|prefix| settings.get(prefix).copied())
}

pub fn by_setting_exactly(name: &str) -> Option<&'static Known> {
    let name = name.trim();
    if !name.is_ascii() || name.is_empty() {
        return None;
    }
    let upper = name.to_ascii_uppercase();
    let settings = &INDEXES.settings;
    settings.get(upper.as_str()).or_else(|| settings.get(format!("{upper}_").as_str())).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(found: Option<&Known>) -> Option<&str> {
        found.map(|known| known.name)
    }

    #[test]
    fn a_package_names_the_service_it_speaks_to() {
        assert_eq!(named(by_package("stripe")), Some("Stripe"));
        assert_eq!(named(by_package("@stripe/react-stripe-js")), Some("Stripe"));
        assert_eq!(named(by_package("@sentry/nextjs")), Some("Sentry"));
        assert_eq!(named(by_package("github.com/jackc/pgx/v5")), Some("PostgreSQL"));
        assert_eq!(named(by_package("@aws-sdk/client-s3")), Some("Amazon S3"));
        assert_eq!(named(by_package("pgx")), None);
        assert_eq!(named(by_package("mongoose")), Some("MongoDB"));
        assert_eq!(named(by_package("./stripe")), None);
        assert_eq!(named(by_package("stripes")), None);
        assert_eq!(named(by_package("crate::common::C_EST_FRANÇAIS_DOCUMENTS")), None);
    }

    #[test]
    fn a_host_names_the_service_behind_it() {
        assert_eq!(named(by_host("api.stripe.com")), Some("Stripe"));
        assert_eq!(named(by_host("www.googletagmanager.com")), Some("Google Analytics"));
        assert_eq!(named(by_host("maps.googleapis.com")), Some("Google Maps"));
        assert_eq!(named(by_host("www.googleapis.com")), Some("Google APIs"));
        assert_eq!(named(by_host("fonts.googleapis.com")), Some("Google Fonts"));
        assert_eq!(named(by_host("notstripe.com")), None);
    }

    #[test]
    fn an_image_names_the_service_it_runs() {
        assert_eq!(named(by_image("postgres:16-alpine")), Some("PostgreSQL"));
        assert_eq!(named(by_image("docker.io/library/redis:7")), Some("Redis"));
        assert_eq!(named(by_image("bitnami/postgresql:15")), Some("PostgreSQL"));
        assert_eq!(named(by_image("ghcr.io/example/app:latest")), None);
    }

    #[test]
    fn a_setting_names_the_service_it_configures() {
        assert_eq!(named(by_setting("STRIPE_SECRET_KEY")), Some("Stripe"));
        assert_eq!(named(by_setting("NEXT_PUBLIC_POSTHOG_KEY")), Some("PostHog"));
        assert_eq!(named(by_setting("SESSION_SECRET")), None);
        assert_eq!(named(by_setting("SENTRY_DSN")), Some("Sentry"));
        assert_eq!(named(by_setting("OTEL_EXPORTER_OTLP_ENDPOINT")), Some("OpenTelemetry Collector"));
        assert_eq!(named(by_setting("PGHOST")), Some("PostgreSQL"));
        assert_eq!(named(by_setting_exactly("google_analytics")), Some("Google Analytics"));
        assert_eq!(named(by_setting_exactly("resend_confirmation")), None);
    }
}

static CLIENTS: &[(&str, &[&str])] = &[
    ("Amazon S3", &["AmazonS3Client", "IAmazonS3", "S3Client"]),
    ("Azure Blob Storage", &["BlobClient", "BlobContainerClient", "BlobServiceClient"]),
    ("Azure Service Bus", &["ServiceBusClient", "ServiceBusProcessor", "ServiceBusReceiver", "ServiceBusSender"]),
    ("Elasticsearch", &["ElasticClient", "ElasticsearchClient", "IElasticClient", "RestHighLevelClient"]),
    ("Kafka", &["ConsumerBuilder", "IAdminClient", "IConsumer", "IProducer", "KafkaConsumer", "KafkaProducer", "ProducerBuilder"]),
    ("MongoDB", &["IMongoClient", "IMongoCollection", "IMongoDatabase", "MongoClient", "MongoCollection", "MongoDatabase"]),
    ("RabbitMQ", &["AsyncEventingBasicConsumer", "ConnectionFactory", "EventingBasicConsumer", "IChannel", "IConnection", "IConnectionFactory", "IModel"]),
    ("Redis", &["ConnectionMultiplexer", "IConnectionMultiplexer", "IDatabase", "IDatabaseAsync", "IServer", "ISubscriber", "Jedis", "JedisPool", "RedisTemplate"]),
];

pub fn a_client_of(specifier: &str, type_name: &str) -> bool {
    let Some(known) = by_package(specifier) else { return false };
    if CLIENTS.iter().any(|(service, types)| *service == known.name && types.contains(&type_name)) {
        return true;
    }
    let first = specifier.split(['.', '/', ':']).next().unwrap_or(specifier);
    first.len() >= 4
        && type_name.strip_prefix(first).is_some_and(|rest| rest.starts_with(char::is_uppercase))
}

#[cfg(test)]
mod clients {
    use super::a_client_of;

    #[test]
    fn a_type_is_a_client_of_the_service_its_namespace_reaches() {
        assert!(a_client_of("Npgsql", "NpgsqlDataSource"));
        assert!(a_client_of("RabbitMQ.Client", "IChannel"));
        assert!(a_client_of("StackExchange.Redis", "IDatabase"));
        assert!(!a_client_of("RabbitMQ.Client", "IDatabase"));
        assert!(!a_client_of("Polly", "IChannel"));
        assert!(!a_client_of("Npgsql", "Npgsqlish"));
    }
}
