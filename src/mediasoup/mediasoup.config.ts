import * as mediasoup from 'mediasoup'
import {cpus} from 'os'

import { Worker, Router } from 'mediasoup/node/lib/types'


const cores = cpus().length

const workerSettings: mediasoup.types.WorkerSettings = {
    logLevel: 'warn',
}

const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
    {
    kind        : "audio",
    mimeType    : "audio/opus",
    clockRate   : 48000,
    channels    : 2
  },
  {
    kind       : "video",
    mimeType   : "video/H264",
    clockRate  : 90000,
    parameters :
    {
      "packetization-mode"      : 1,
      "profile-level-id"        : "42e01f",
      "level-asymmetry-allowed" : 1
    }
  }
]

const workers : Worker[] = []
const routers = new Map<string, Router>()
let nextWorkerIndex = 0;

const use = cores / 4;

// creating mediasoup worker

export const createWorkers = async (): Promise<void> => {
    console.log(`Creating ${use} mediasoup workers ...`);

    for(let i = 0; i < use; i++) {
        const worker = await mediasoup.createWorker(workerSettings)

        worker.on('died', () => {
            console.error(`Mediasoup worker with pid ${worker.pid} has died`);

            // exit the process to allow a process manager to restart it
            setTimeout(() => process.exit(1), 2000)
        })

        workers.push(worker)

        console.log(`created worker with pid: ${worker.pid}`);
        
    }
    
}

// this function finds the next availble worker in round robin function

const getNextWorker = (): Worker => {
    if(workers.length == 0) {
        throw new Error("NO WORKER PRESENT --> CALL createWorkers() first")
    }
    const worker = workers[nextWorkerIndex];
    nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;


    return worker;
}

// creates mediasoup router for a given room ID

const createRouter = async (roomId: string): Promise<Router> => {
    const worker = getNextWorker();
    const router = await worker.createRouter({mediaCodecs})

    routers.set(roomId, router);
    console.log(`Router created for room '${roomId}' on worker ${worker.pid}`);

    // remove router from map when it's closed

    router.on('@close', () => {
        routers.delete(roomId)
        console.log(`Router for room '${roomId}' closed.`);
    }  )

    return router;
    
}

// retrieves an existing router or create a new one if it doesn't exist

export const getRouter = async (roomId : string) : Promise<Router> => {
    const router  = routers.get(roomId)

    if(router && !router.closed) {
        return router
    }

    return createRouter(roomId)
}







