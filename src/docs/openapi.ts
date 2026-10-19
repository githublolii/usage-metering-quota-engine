/**
 * OpenAPI 3.0 specification for the Quota Engine — hand-authored (no runtime
 * doc-generation dependency), served at `/openapi.json` and rendered as an
 * interactive explorer at `/docs` (Swagger UI).
 *
 * Kept in TypeScript so the spec is type-checked at build time and lives
 * next to the code it documents.
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Usage Metering & Quota Engine',
    version: '1.0.0',
    description:
      'Multi-tenant usage metering and quota engine. Dual-quota consumption ' +
      '(account plan + user plan evaluated simultaneously), pessimistic row ' +
      'locking with deterministic lock order, database-enforced idempotency, ' +
      'monotonic counters with implicit UTC monthly rollover, RFC 7807 errors.\n\n' +
      '**Auth:** every authenticated route accepts `X-API-Key` or `Authorization: Bearer`. ' +
      'Provision an account via `POST /accounts` to obtain a key (shown exactly once).',
    license: { name: 'MIT' },
  },
  servers: [{ url: '/', description: 'this instance' }],
  tags: [
    { name: 'System', description: 'Health' },
    { name: 'Accounts', description: 'Provisioning, key lifecycle, runtime plan binding' },
    { name: 'Plans', description: 'Predefined catalog + tenant-scoped custom plans (CRUD)' },
    { name: 'Users', description: 'Tenant-scoped user registration + runtime plan mutation' },
    { name: 'Metering', description: 'The quota decision, usage views, audit history' },
  ],
  'x-design-notes': {
    'status codes':
      '200 accepted decision (or idempotent replay) · 201 created · ' +
      '400 validation problem+json · 401 unauthenticated · 404 unknown within ' +
      'tenant (IDOR-safe) · 409 conflict · 422 quota rejection (business payload, ' +
      'NOT problem+json — a rejection is a successful decision) · 500 generic',
    idempotency:
      'POST /metering/consume is idempotent per (account, requestId). Replays ' +
      'return the original status code + frozen payload with X-Idempotent-Replay: true.',
  },
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Process + database liveness',
        security: [],
        responses: {
          200: { description: 'Healthy', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, uptimeSeconds: { type: 'integer' }, poolMax: { type: 'integer' } } } } } },
          503: { description: 'Database unreachable' },
        },
      },
    },
    '/accounts': {
      post: {
        tags: ['Accounts'],
        summary: 'Provision an account (bootstrap; API key returned exactly once)',
        description:
          'The one public route: you need an account to authenticate. The key is ' +
          'generated server-side (256-bit), stored only as a SHA-256 digest, and ' +
          'returned in plaintext exactly once.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', maxLength: 255 },
                  planName: { $ref: '#/components/schemas/PlanRef' },
                  planId: { $ref: '#/components/schemas/PlanRef' },
                },
              },
              example: { name: 'acme-corp', planName: 'Starter' },
            },
          },
        },
        responses: {
          201: {
            description: 'Account created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    account: { $ref: '#/components/schemas/AccountView' },
                    apiKey: { type: 'string', example: 'mk_… (shown exactly once)' },
                  },
                },
              },
            },
          },
          404: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/accounts/me': {
      get: {
        tags: ['Accounts'],
        summary: 'Profile, bound plan, live usage for the current UTC month',
        responses: {
          200: {
            description: 'Account view',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    account: {
                      allOf: [
                        { $ref: '#/components/schemas/AccountView' },
                        {
                          type: 'object',
                          properties: {
                            usage: {
                              type: 'object',
                              properties: {
                                period: { type: 'string', example: '2026-10' },
                                unitsConsumed: { type: 'integer' },
                                remaining: { type: 'integer' },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/accounts/rotate-key': {
      post: {
        tags: ['Accounts'],
        summary: 'Atomically invalidate the old key and issue a new one',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false } } } },
        responses: {
          200: { description: 'New key (shown exactly once)', content: { 'application/json': { schema: { type: 'object', properties: { apiKey: { type: 'string' }, warning: { type: 'string' } } } } } },
          401: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/accounts/plan': {
      patch: {
        tags: ['Accounts'],
        summary: 'Runtime plan mutation (no restart; monotonic usage preserved)',
        description:
          'Rebind the account to an ACCOUNT-type plan it may use (predefined or ' +
          'its own custom). Usage counters are never rewritten — `remaining` is ' +
          'derived, so a downgrade clamps it to 0 until next month and an upgrade ' +
          'expands capacity instantly.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ChangePlan' },
              examples: { byName: { value: { planName: 'Pro' } }, byId: { value: { planId: '4c051982-87e3-43f5-9ed5-6054b86badb2' } } },
            },
          },
        },
        responses: {
          200: { description: 'Account view with the new binding', content: { 'application/json': { schema: { type: 'object', properties: { account: { $ref: '#/components/schemas/AccountView' } } } } } },
          401: { $ref: '#/components/responses/Problem' },
          404: { $ref: '#/components/responses/Problem' },
          409: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/plans': {
      get: {
        tags: ['Plans'],
        summary: 'Predefined catalog + this account’s custom plans',
        responses: {
          200: { description: 'Visible plans', content: { 'application/json': { schema: { type: 'object', properties: { plans: { type: 'array', items: { $ref: '#/components/schemas/PlanView' } } } } } } },
        },
      },
      post: {
        tags: ['Plans'],
        summary: 'Create a custom plan (tenant-scoped)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'type', 'monthlyAllowance', 'maxUnitsPerRequest'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', maxLength: 100 },
                  type: { type: 'string', enum: ['ACCOUNT', 'USER'] },
                  monthlyAllowance: { type: 'integer', minimum: 0 },
                  maxUnitsPerRequest: { type: 'integer', minimum: 1 },
                },
              },
              example: { name: 'Enterprise', type: 'ACCOUNT', monthlyAllowance: 10000, maxUnitsPerRequest: 100 },
            },
          },
        },
        responses: {
          201: { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { plan: { $ref: '#/components/schemas/PlanView' } } } } } },
          400: { $ref: '#/components/responses/Problem' },
          409: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/plans/{id}': {
      patch: {
        tags: ['Plans'],
        summary: 'Update a custom plan owned by the caller (type is immutable)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                minProperties: 1,
                additionalProperties: false,
                properties: {
                  name: { type: 'string', maxLength: 100 },
                  monthlyAllowance: { type: 'integer', minimum: 0 },
                  maxUnitsPerRequest: { type: 'integer', minimum: 1 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated', content: { 'application/json': { schema: { type: 'object', properties: { plan: { $ref: '#/components/schemas/PlanView' } } } } } },
          400: { $ref: '#/components/responses/Problem' },
          404: { $ref: '#/components/responses/Problem' },
          409: { $ref: '#/components/responses/Problem' },
        },
      },
      delete: {
        tags: ['Plans'],
        summary: 'Delete a custom plan — 409 while any account/user is still bound',
        description: 'Predefined catalog plans and other tenants’ plans return 404 (IDOR-safe).',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' }, planId: { type: 'string' } } } } } },
          404: { $ref: '#/components/responses/Problem' },
          409: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/users': {
      post: {
        tags: ['Users'],
        summary: 'Register a user under the authenticated account',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['userId'],
                additionalProperties: false,
                properties: {
                  userId: { type: 'string', description: 'caller-facing external id', maxLength: 255 },
                  planName: { $ref: '#/components/schemas/PlanRef' },
                  planId: { $ref: '#/components/schemas/PlanRef' },
                },
              },
              example: { userId: 'user-1', planName: 'Basic' },
            },
          },
        },
        responses: {
          201: { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/UserView' } } } } } },
          400: { $ref: '#/components/responses/Problem' },
          404: { $ref: '#/components/responses/Problem' },
          409: { $ref: '#/components/responses/Problem' },
        },
      },
      get: {
        tags: ['Users'],
        summary: 'List this account’s users',
        responses: {
          200: { description: 'Users', content: { 'application/json': { schema: { type: 'object', properties: { users: { type: 'array', items: { $ref: '#/components/schemas/UserView' } } } } } } },
        },
      },
    },
    '/users/{userId}/plan': {
      patch: {
        tags: ['Users'],
        summary: 'Runtime user plan mutation (usage preserved)',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangePlan' }, example: { planName: 'Premium' } } } },
        responses: {
          200: { description: 'User view with the new plan', content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/UserView' } } } } } },
          404: { $ref: '#/components/responses/Problem' },
          409: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/metering/consume': {
      post: {
        tags: ['Metering'],
        summary: 'The quota decision (idempotent via requestId)',
        description:
          'Evaluates all four rules — user/account × per-request/monthly — under ' +
          'pessimistic row locks; accepts only if BOTH plans allow it (all-or-nothing). ' +
          'Idempotent per (account, requestId): replays return the original decision ' +
          'with `X-Idempotent-Replay: true`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['userId', 'units', 'requestId'],
                additionalProperties: false,
                properties: {
                  userId: { type: 'string' },
                  units: { type: 'integer', minimum: 1, maximum: 1000000000 },
                  requestId: { type: 'string', format: 'uuid', description: 'idempotency key' },
                },
              },
              example: { userId: 'user-1', units: 10, requestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
            },
          },
        },
        responses: {
          200: {
            description: 'Accepted (or idempotent replay of an accepted decision)',
            headers: { 'X-Idempotent-Replay': { schema: { type: 'string', enum: ['true', 'false'] } } },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ConsumeAccepted' }, example: { accepted: true, requestId: '7c9e6679-…', period: '2026-10', unitsConsumed: 10, usage: { account: { planName: 'Starter', planType: 'ACCOUNT', monthlyAllowance: 100, maxUnitsPerRequest: 10, unitsConsumed: 10, remaining: 90 }, user: { planName: 'Basic', planType: 'USER', monthlyAllowance: 100, maxUnitsPerRequest: 20, unitsConsumed: 10, remaining: 90 } } } } },
          },
          422: {
            description: 'Rejected — well-formed request violating quota policy. ZERO units consumed. (Not an error: business payload, not problem+json.)',
            headers: { 'X-Idempotent-Replay': { schema: { type: 'string', enum: ['true', 'false'] } } },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ConsumeRejected' },
                example: { accepted: false, requestId: 'c4b3…', period: '2026-10', reason: 'Request exceeds user maximum units per request limit.', violation: { source: 'user', rule: 'max_units_per_request', limit: 20, requestedUnits: 25, currentUsage: 10, remainingMonthly: 90 } },
              },
            },
          },
          409: {
            description:
              'Idempotency conflict — this requestId was already decided with a DIFFERENT request payload ' +
              '(userId and/or units). One idempotency key maps to exactly one request; use a new key. ' +
              'problem+json; nothing was charged.',
            content: {
              'application/problem+json': {
                schema: { $ref: '#/components/schemas/Problem' },
                example: {
                  type: 'urn:quota-engine:errors:CONFLICT',
                  title: 'Request conflicts with current state',
                  status: 409,
                  detail: 'This requestId was already used with a different request payload. An idempotency key maps to exactly one immutable decision — use a new requestId for a new request.',
                  instance: '/metering/consume',
                },
              },
            },
          },
          400: { $ref: '#/components/responses/Problem' },
          401: { $ref: '#/components/responses/Problem' },
          404: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/metering/usage': {
      get: {
        tags: ['Metering'],
        summary: 'Usage views (account + optional user), for the current or any period',
        description:
          '`period=YYYY-MM` (UTC) makes history addressable: previous months are ' +
          'frozen, and a future/next month correctly reads as zero (rows are created ' +
          'lazily on first touch).',
        parameters: [
          { name: 'userId', in: 'query', schema: { type: 'string' }, description: 'external user id' },
          { name: 'period', in: 'query', schema: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' }, example: '2026-09' },
        ],
        responses: {
          200: {
            description: 'Usage report',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    period: { type: 'string' },
                    account: { $ref: '#/components/schemas/PlanUsageView' },
                    user: { $ref: '#/components/schemas/PlanUsageView' },
                  },
                },
              },
            },
          },
          400: { $ref: '#/components/responses/Problem' },
          404: { $ref: '#/components/responses/Problem' },
        },
      },
    },
    '/metering/history': {
      get: {
        tags: ['Metering'],
        summary: 'Paginated consumption audit trail (period/decision filterable)',
        parameters: [
          { name: 'userId', in: 'query', schema: { type: 'string' } },
          { name: 'period', in: 'query', schema: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' } },
          { name: 'accepted', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          200: {
            description: 'History page',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    records: { type: 'array', items: { $ref: '#/components/schemas/HistoryRecord' } },
                    total: { type: 'integer' },
                    limit: { type: 'integer' },
                    offset: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      BearerAuth: { type: 'http', scheme: 'bearer' },
    },
    responses: {
      Problem: {
        description: 'RFC 7807 problem+json (status varies: 400/401/404/409/500)',
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
            example: { type: 'urn:quota-engine:errors:NOT_FOUND', title: 'Resource not found', status: 404, detail: 'User "user-2" does not exist in this account.', instance: '/metering/consume' },
          },
        },
      },
    },
    schemas: {
      PlanRef: { type: 'string', description: 'Reference by name (custom plans shadow predefined) or by id — exactly one of the two per request.' },
      ChangePlan: {
        type: 'object',
        additionalProperties: false,
        description: 'Exactly one of planName / planId is required.',
        properties: { planName: { type: 'string' }, planId: { type: 'string', format: 'uuid' } },
      },
      PlanView: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['ACCOUNT', 'USER'] },
          isPredefined: { type: 'boolean' },
          monthlyAllowance: { type: 'integer' },
          maxUnitsPerRequest: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      AccountView: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          plan: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              type: { type: 'string', enum: ['ACCOUNT'] },
              monthlyAllowance: { type: 'integer' },
              maxUnitsPerRequest: { type: 'integer' },
            },
          },
        },
      },
      UserView: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: 'external id' },
          createdAt: { type: 'string', format: 'date-time' },
          plan: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              type: { type: 'string', enum: ['USER'] },
              monthlyAllowance: { type: 'integer' },
              maxUnitsPerRequest: { type: 'integer' },
            },
          },
        },
      },
      PlanUsageView: {
        type: 'object',
        description: 'Plan rules + live monotonic usage; remaining is derived (GREATEST(0, allowance − consumed)).',
        properties: {
          planName: { type: 'string' },
          planType: { type: 'string', enum: ['ACCOUNT', 'USER'] },
          monthlyAllowance: { type: 'integer' },
          maxUnitsPerRequest: { type: 'integer' },
          unitsConsumed: { type: 'integer' },
          remaining: { type: 'integer' },
        },
      },
      Violation: {
        type: 'object',
        description: 'Deterministic root cause (precedence: user/per-request → account/per-request → user/monthly → account/monthly).',
        properties: {
          source: { type: 'string', enum: ['account', 'user'] },
          rule: { type: 'string', enum: ['monthly_allowance', 'max_units_per_request'] },
          limit: { type: 'integer' },
          requestedUnits: { type: 'integer' },
          currentUsage: { type: 'integer' },
          remainingMonthly: { type: 'integer', description: 'GREATEST(0, allowance − usage) for the violated entity' },
        },
      },
      ConsumeAccepted: {
        type: 'object',
        properties: {
          accepted: { type: 'boolean', enum: [true] },
          requestId: { type: 'string', format: 'uuid' },
          period: { type: 'string', example: '2026-10' },
          unitsConsumed: { type: 'integer' },
          usage: { type: 'object', properties: { account: { $ref: '#/components/schemas/PlanUsageView' }, user: { $ref: '#/components/schemas/PlanUsageView' } } },
        },
      },
      ConsumeRejected: {
        type: 'object',
        properties: {
          accepted: { type: 'boolean', enum: [false] },
          requestId: { type: 'string', format: 'uuid' },
          period: { type: 'string' },
          reason: { type: 'string' },
          violation: { $ref: '#/components/schemas/Violation' },
        },
      },
      HistoryRecord: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          userId: { type: 'string' },
          unitsRequested: { type: 'integer' },
          accepted: { type: 'boolean' },
          rejectionReason: { type: 'string', nullable: true },
          rejectionSource: { type: 'string', nullable: true },
          rejectionRule: { type: 'string', nullable: true },
          period: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          response: { description: 'Frozen decision payload (byte-faithful replay source)', oneOf: [{ $ref: '#/components/schemas/ConsumeAccepted' }, { $ref: '#/components/schemas/ConsumeRejected' }] },
        },
      },
      Problem: {
        type: 'object',
        description: 'RFC 7807 problem+json',
        properties: {
          type: { type: 'string', example: 'urn:quota-engine:errors:VALIDATION_FAILED' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          instance: { type: 'string' },
          errors: { type: 'array', description: 'Present for 400 validation failures', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' }, code: { type: 'string' } } } },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
} as const;
