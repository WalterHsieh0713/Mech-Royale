FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY package.json main.ts bot.ts map.ts belief.ts strategy.ts third-party.ts ./
ENTRYPOINT ["bun", "/bot/main.ts"]
