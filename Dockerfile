FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY package.json main.ts brain.ts bot.ts map.ts belief.ts strategy.ts third-party.ts profile.ts ./
ENTRYPOINT ["bun", "/bot/main.ts"]
