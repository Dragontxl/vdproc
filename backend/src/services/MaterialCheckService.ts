import { Bindings } from '../types/env';
import { TaskPhase } from '../types';

interface CheckResult {
  ready: boolean;
  missing: string[];
  available: string[];
}

export class MaterialCheckService {
  constructor(private env: Bindings) {}

  async checkPhaseRequirements(taskId: string, phase: TaskPhase, videoPath?: string): Promise<CheckResult> {
    const requirements = this.getPhaseRequirements(phase);
    
    const missing: string[] = [];
    const available: string[] = [];

    for (const req of requirements) {
      if (await this.isMaterialAvailable(taskId, req, videoPath)) {
        available.push(req);
      } else {
        missing.push(req);
      }
    }

    return {
      ready: missing.length === 0,
      missing,
      available,
    };
  }

  private getPhaseRequirements(phase: TaskPhase): string[] {
    const requirements: Record<TaskPhase, string[]> = {
      DETECT: ['video'],
      ANALYZE: ['video', 'shots'],
      SELECT_FACES: ['video', 'shots'],
      GENERATE_CHARACTERS: ['character_frames'],
      CROP_SHOTS: ['video', 'shot_details'],
      CONVERT_FRAMES: ['shot_frames', 'character_avatars', 'shot_details'],
      GENERATE_SHOTS: ['ai_shot_frames', 'shot_details'],
      COMPOSE: ['shot_videos'],
    };
    return requirements[phase] || [];
  }

  private async isMaterialAvailable(taskId: string, material: string, videoPath?: string): Promise<boolean> {
    switch (material) {
      case 'video':
        if (videoPath) {
          return this.checkR2FileExists(videoPath);
        }
        return this.checkR2FileExists(`${taskId}/input/video.mp4`);
      case 'shots':
        return this.checkR2PathExists(`${taskId}/scenes/`);
      case 'shot_details':
        return this.checkR2PathExists(`${taskId}/scenes/`);
      case 'character_frames':
        return this.checkTableHasData('character_frames', taskId);
      case 'character_avatars':
        return this.checkR2PathExists(`${taskId}/characters/`);
      case 'shot_frames':
        return this.checkR2PathExists(`${taskId}/shot_frames/`);
      case 'ai_shot_frames':
        return this.checkR2PathExists(`${taskId}/ai_shot_frames/`);
      case 'shot_videos':
        return this.checkR2PathExists(`${taskId}/shot_videos/`);
      default:
        return false;
    }
  }

  private async checkR2FileExists(path: string): Promise<boolean> {
    try {
      const obj = await this.env.R2.get(path);
      return obj !== null;
    } catch {
      return false;
    }
  }

  private async checkR2PathExists(path: string): Promise<boolean> {
    try {
      const list = await this.env.R2.list({ prefix: path });
      return list.objects.length > 0;
    } catch {
      return false;
    }
  }

  private async checkTableHasData(table: string, taskId: string): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `SELECT COUNT(*) as count FROM ${table} WHERE task_id = ?`
    ).bind(taskId).first();
    return (result as { count: number }).count > 0;
  }
}