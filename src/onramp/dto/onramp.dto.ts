import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches, MaxLength } from "class-validator";

/**
 * `POST /onramp/sessions` body (spec §5.2).
 *
 * No `appUserId` (taken from the JWT) and no `assets` (built from the
 * server support matrix): neither is client-controlled (§5.3).
 */
export class CreateOnrampSessionDto {
  @ApiProperty({ example: "0x0000000000000000000000000000000000000000" })
  @IsString()
  @MaxLength(128)
  destinationAddress!: string;

  @ApiProperty({
    example: "eip155:5042002",
    description: "CAIP-2 receiving chain",
  })
  @IsString()
  @Matches(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/)
  chainKey!: string;
}
