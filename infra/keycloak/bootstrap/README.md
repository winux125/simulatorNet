# Keycloak bootstrap

The committed realm import reads the development service-client secret from
`EXTERNAL_PLATFORM_CLIENT_SECRET`. Bootstrap/admin credentials are supplied only by
the local `.env` file through Compose. This directory intentionally contains no
Admin REST automation or credentials; client lifecycle management is outside M8.
