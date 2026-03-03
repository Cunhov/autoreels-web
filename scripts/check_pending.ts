const { prisma } = require('../lib/prisma')

async function main() {
  const planners = await prisma.planner.findMany({ where: { status: { not: 'paused' } } })
  console.log('Active planners:', planners.map(p => ({ id: p.id, last_run: p.last_run })))
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect() })
