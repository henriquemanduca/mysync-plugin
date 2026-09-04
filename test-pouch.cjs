const PouchDB = require('pouchdb');

async function run() {
    const db1 = new PouchDB('db1-test');
    const db2 = new PouchDB('db2-test');
    
    for (let i = 0; i < 50; i++) {
        await db1.put({_id: 'doc' + i, value: i});
    }
    
    let docsWrittenCounts = [];
    db1.replicate.to(db2, {batch_size: 10})
        .on('change', (info) => {
            docsWrittenCounts.push(info.docs_written);
        })
        .on('complete', async (info) => {
            console.log("Change docs_written:", docsWrittenCounts);
            console.log("Complete info.docs_written:", info.docs_written);
            await db1.destroy();
            await db2.destroy();
        })
        .on('error', (err) => console.error(err));
}
run();
