FROM node:24-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @simulatornet/api build

FROM node:24-alpine
WORKDIR /workspace
RUN corepack enable
COPY --from=build /workspace /workspace
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm db:seed:dev && pnpm --filter @simulatornet/api start"]
