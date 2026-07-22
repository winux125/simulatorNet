# PostgreSQL development services

Compose runs logically separate PostgreSQL 18 services and named volumes for
SimulatorNet application data and Keycloak data. Application migrations remain
owned by `packages/db/migrations`; Keycloak manages only its own database.
