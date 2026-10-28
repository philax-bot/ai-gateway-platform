import {rename} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';

/** Windows readers/scanners can briefly deny replacement of an otherwise valid file. */
export async function replaceJournalFile(temporary:string,target:string,move:typeof rename=rename){
  const delays=[10,20,40,80,160,320];
  for(let attempt=0;;attempt++){
    try{await move(temporary,target);return;}
    catch(error){
      if(!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')||attempt===delays.length)throw error;
      await pause(delays[attempt]);
    }
  }
}
