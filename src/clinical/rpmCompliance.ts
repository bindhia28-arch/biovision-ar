export interface ComplianceSession {
  patientId: string;
  capturedAt: string;
  scanId: string;
  mode: "consumer" | "clinical-pro";
}

export class RpmComplianceLogger {
  private readonly sessions: ComplianceSession[] = [];

  public record(session: ComplianceSession): void {
    this.sessions.push({ ...session });
  }

  public list(patientId: string): readonly ComplianceSession[] {
    return this.sessions.filter((session) => session.patientId === patientId);
  }

  public rate(patientId: string, expectedSessions: number, periodStart: Date, periodEnd: Date): number {
    if (expectedSessions <= 0) throw new RangeError("Expected sessions must be greater than zero");
    const completed = this.list(patientId).filter(({ capturedAt }) => {
      const time = Date.parse(capturedAt);
      return time >= periodStart.getTime() && time <= periodEnd.getTime();
    }).length;
    return Math.min(1, completed / expectedSessions);
  }
}
