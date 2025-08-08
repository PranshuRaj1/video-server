import dgram from 'dgram';

export async function getFreeUdpPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.bind(0, () => {
            const address = socket.address();
            socket.close();
            if (typeof address === 'object') {
                resolve(address.port);
            } else {
                reject(new Error('Could not determine free UDP port'));
            }
        });
    });
}
